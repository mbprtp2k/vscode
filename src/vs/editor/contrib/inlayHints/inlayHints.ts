/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedExternalError } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { InlayHint, InlayHintList, InlayHintsProvider, InlayHintsProviderRegistry } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';

export class InlayHintAnchor {
	constructor(readonly range: Range, readonly direction: 'before' | 'after') { }
}

export class InlayHintItem {

	private _isResolved: boolean = false;
	private _currentResolve?: Promise<void>;

	constructor(readonly hint: InlayHint, readonly anchor: InlayHintAnchor, private readonly _provider: InlayHintsProvider) { }

	with(delta: { anchor: InlayHintAnchor; }): InlayHintItem {
		const result = new InlayHintItem(this.hint, delta.anchor, this._provider);
		result._isResolved = this._isResolved;
		result._currentResolve = this._currentResolve;
		return result;
	}

	async resolve(token: CancellationToken): Promise<void> {
		if (typeof this._provider.resolveInlayHint !== 'function') {
			return;
		}
		if (this._currentResolve) {
			// wait for an active resolve operation and try again
			// when that's done.
			await this._currentResolve;
			if (token.isCancellationRequested) {
				return;
			}
			return this.resolve(token);
		}
		if (!this._isResolved) {
			this._currentResolve = this._doResolve(token)
				.finally(() => this._currentResolve = undefined);
		}
		await this._currentResolve;
	}

	private async _doResolve(token: CancellationToken) {
		try {
			const newHint = await Promise.resolve(this._provider.resolveInlayHint!(this.hint, token));
			this.hint.tooltip = newHint?.tooltip ?? this.hint.tooltip;
			this.hint.label = newHint?.label ?? this.hint.label;
			this._isResolved = true;
		} catch (err) {
			onUnexpectedExternalError(err);
			this._isResolved = false;
		}
	}
}

export class InlayHintsFragments {

	static async create(model: ITextModel, ranges: Range[], token: CancellationToken): Promise<InlayHintsFragments> {

		const data: [InlayHintList, InlayHintsProvider][] = [];

		const promises = InlayHintsProviderRegistry.ordered(model).reverse().map(provider => ranges.map(async range => {
			try {
				const result = await provider.provideInlayHints(model, range, token);
				if (result?.hints.length) {
					data.push([result, provider]);
				}
			} catch (err) {
				onUnexpectedExternalError(err);
			}
		}));

		await Promise.all(promises.flat());

		return new InlayHintsFragments(data, model);
	}

	private readonly _disposables = new DisposableStore();
	private readonly _onDidChange = new Emitter<void>();

	readonly onDidReceiveProviderSignal: Event<void> = this._onDidChange.event;
	readonly items: readonly InlayHintItem[];

	private constructor(data: [InlayHintList, InlayHintsProvider][], model: ITextModel) {
		const items: InlayHintItem[] = [];
		for (const [list, provider] of data) {
			this._disposables.add(list);
			for (let hint of list.hints) {

				// compute the range to which the item should be attached to
				let position = model.validatePosition(hint.position);
				let direction: 'before' | 'after' = 'before';

				const wordRange = InlayHintsFragments._getRangeAtPosition(model, position);
				let range: Range;

				if (wordRange.getStartPosition().isBefore(position)) {
					range = Range.fromPositions(wordRange.getStartPosition(), position);
					direction = 'after';
				} else {
					range = Range.fromPositions(position, wordRange.getEndPosition());
					direction = 'before';
				}

				items.push(new InlayHintItem(hint, new InlayHintAnchor(range, direction), provider));
			}
			if (provider.onDidChangeInlayHints) {
				provider.onDidChangeInlayHints(this._onDidChange.fire, this._onDidChange, this._disposables);
			}
		}
		this.items = items.sort((a, b) => Position.compare(a.hint.position, b.hint.position));
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._disposables.dispose();
	}

	private static _getRangeAtPosition(model: ITextModel, position: IPosition): Range {
		const line = position.lineNumber;
		const word = model.getWordAtPosition(position);
		if (word) {
			// always prefer the word range
			return new Range(line, word.startColumn, line, word.endColumn);
		}

		model.tokenizeIfCheap(line);
		const tokens = model.getLineTokens(line);
		const offset = position.column - 1;
		const idx = tokens.findTokenIndexAtOffset(offset);

		let start = tokens.getStartOffset(idx);
		let end = tokens.getEndOffset(idx);

		if (end - start === 1) {
			// single character token, when at its end try leading/trailing token instead
			if (start === offset && idx > 1) {
				// leading token
				start = tokens.getStartOffset(idx - 1);
				end = tokens.getEndOffset(idx - 1);
			} else if (end === offset && idx < tokens.getCount() - 1) {
				// trailing token
				start = tokens.getStartOffset(idx + 1);
				end = tokens.getEndOffset(idx + 1);
			}
		}

		return new Range(line, start + 1, line, end + 1);
	}
}
