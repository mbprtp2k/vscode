/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/notebookFind';
import { alert as alertFn } from 'vs/base/browser/ui/aria/aria';
import * as strings from 'vs/base/common/strings';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService, IContextKey, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { KEYBINDING_CONTEXT_NOTEBOOK_FIND_WIDGET_FOCUSED, INotebookEditor, CellEditState, INotebookEditorContribution, NOTEBOOK_EDITOR_FOCUSED, getNotebookEditorFromEditorPane, NOTEBOOK_IS_ACTIVE_EDITOR } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { Range } from 'vs/editor/common/core/range';
import { MATCHES_LIMIT } from 'vs/editor/contrib/find/findModel';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import * as DOM from 'vs/base/browser/dom';
import { registerNotebookContribution } from 'vs/workbench/contrib/notebook/browser/notebookEditorExtensions';
import { registerAction2, Action2 } from 'vs/platform/actions/common/actions';
import { localize } from 'vs/nls';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { FindReplaceState } from 'vs/editor/contrib/find/findState';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { StartFindAction, StartFindReplaceAction } from 'vs/editor/contrib/find/findController';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { NLS_MATCHES_LOCATION, NLS_NO_RESULTS } from 'vs/editor/contrib/find/findWidget';
import { FindModel } from 'vs/workbench/contrib/notebook/browser/contrib/find/findModel';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { FindMatch } from 'vs/editor/common/model';
import { SimpleFindReplaceWidget } from 'vs/workbench/contrib/notebook/browser/contrib/find/notebookFindReplaceWidget';

const FIND_HIDE_TRANSITION = 'find-hide-transition';
const FIND_SHOW_TRANSITION = 'find-show-transition';
let MAX_MATCHES_COUNT_WIDTH = 69;


export class NotebookFindWidget extends SimpleFindReplaceWidget implements INotebookEditorContribution {
	static id: string = 'workbench.notebook.find';
	protected _findWidgetFocused: IContextKey<boolean>;
	private _showTimeout: number | null = null;
	private _hideTimeout: number | null = null;
	private _previousFocusElement?: HTMLElement;
	private _findModel: FindModel;
	private _styleElement!: HTMLStyleElement;

	constructor(
		private readonly _notebookEditor: INotebookEditor,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService

	) {
		super(contextViewService, contextKeyService, themeService, configurationService, new FindReplaceState(), true);
		this._findModel = new FindModel(this._notebookEditor, this._state, this._configurationService);

		DOM.append(this._notebookEditor.getDomNode(), this.getDomNode());

		this._findWidgetFocused = KEYBINDING_CONTEXT_NOTEBOOK_FIND_WIDGET_FOCUSED.bindTo(contextKeyService);
		this._register(this._findInput.onKeyDown((e) => this._onFindInputKeyDown(e)));
		this.updateTheme(themeService.getColorTheme());
		this._register(themeService.onDidColorThemeChange(() => {
			this.updateTheme(themeService.getColorTheme());
		}));

		this._register(this._state.onFindReplaceStateChange((e) => {
			this.onInputChanged();

			if (e.isSearching) {
				if (this._state.isSearching) {
					this._progressBar.infinite().show();
				} else {
					this._progressBar.stop();
				}
			}

			if (this._findModel.currentMatch >= 0) {
				const currentMatch = this._findModel.getCurrentMatch();
				this._replaceBtn.setEnabled(currentMatch.isModelMatch);
			}
		}));

		this._register(DOM.addDisposableListener(this.getDomNode(), DOM.EventType.FOCUS, e => {
			this._previousFocusElement = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : undefined;
		}, true));

		this._createLayoutStyles();
	}

	private _createLayoutStyles(): void {
		this._styleElement = DOM.createStyleSheet(this.getDomNode());
		const experimental = this._configurationService.getValue<boolean>('notebook.find.experimental');
		const styleSheets: string[] = [];
		if (experimental) {
			styleSheets.push('.monaco-workbench .simple-fr-find-part-wrapper { width: 341px; }');
		} else {
			styleSheets.push('.monaco-workbench .simple-fr-find-part-wrapper { width: 318px; }');
		}

		this._styleElement.textContent = styleSheets.join('\n');
	}

	private _onFindInputKeyDown(e: IKeyboardEvent): void {
		if (e.equals(KeyCode.Enter)) {
			this._findModel.find(false);
			e.preventDefault();
			return;
		} else if (e.equals(KeyMod.Shift | KeyCode.Enter)) {
			this.find(true);
			e.preventDefault();
			return;
		}
	}

	protected onInputChanged(): boolean {
		this._state.change({ searchString: this.inputValue }, false);
		// this._findModel.research();
		const findMatches = this._findModel.findMatches;
		if (findMatches && findMatches.length) {
			return true;
		}

		return false;
	}

	protected find(previous: boolean): void {
		this._findModel.find(previous);
	}

	protected replaceOne() {
		if (!this._notebookEditor.hasModel()) {
			return;
		}

		if (!this._findModel.findMatches.length) {
			return;
		}

		this._findModel.ensureFindMatches();

		if (this._findModel.currentMatch < 0) {
			this._findModel.find(false);
		}

		const currentMatch = this._findModel.getCurrentMatch();
		const cell = currentMatch.cell;
		if (currentMatch.isModelMatch) {
			const match = currentMatch.match as FindMatch;

			this._progressBar.infinite().show();

			const replacePattern = this.replacePattern;
			const replaceString = replacePattern.buildReplaceString(match.matches, this._state.preserveCase);

			const viewModel = this._notebookEditor._getViewModel();
			viewModel.replaceOne(cell, match.range, replaceString).then(() => {
				this._progressBar.stop();
			});
		} else {
			// this should not work
			console.error('Replace does not work for output match');
		}
	}

	protected replaceAll() {
		if (!this._notebookEditor.hasModel()) {
			return;
		}

		this._progressBar.infinite().show();

		const replacePattern = this.replacePattern;

		const cellFindMatches = this._findModel.findMatches;
		const replaceStrings: string[] = [];
		cellFindMatches.forEach(cellFindMatch => {
			const findMatches = cellFindMatch.matches;
			findMatches.forEach((findMatch, index) => {
				if (index < cellFindMatch.modelMatchCount) {
					const match = findMatch as FindMatch;
					const matches = match.matches;
					replaceStrings.push(replacePattern.buildReplaceString(matches, this._state.preserveCase));
				}
			});
		});

		const viewModel = this._notebookEditor._getViewModel();
		viewModel.replaceAll(this._findModel.findMatches, replaceStrings).then(() => {
			this._progressBar.stop();
		});
	}

	protected findFirst(): void { }

	protected onFocusTrackerFocus() {
		this._findWidgetFocused.set(true);
	}

	protected onFocusTrackerBlur() {
		this._previousFocusElement = undefined;
		this._findWidgetFocused.reset();
	}

	protected onReplaceInputFocusTrackerFocus(): void {
		// throw new Error('Method not implemented.');
	}
	protected onReplaceInputFocusTrackerBlur(): void {
		// throw new Error('Method not implemented.');
	}

	protected onFindInputFocusTrackerFocus(): void { }
	protected onFindInputFocusTrackerBlur(): void { }

	override show(initialInput?: string): void {
		super.show(initialInput);
		this._state.change({ searchString: initialInput ?? '', isRevealed: true }, false);
		this._findInput.select();

		if (this._showTimeout === null) {
			if (this._hideTimeout !== null) {
				window.clearTimeout(this._hideTimeout);
				this._hideTimeout = null;
				this._notebookEditor.removeClassName(FIND_HIDE_TRANSITION);
			}

			this._notebookEditor.addClassName(FIND_SHOW_TRANSITION);
			this._showTimeout = window.setTimeout(() => {
				this._notebookEditor.removeClassName(FIND_SHOW_TRANSITION);
				this._showTimeout = null;
			}, 200);
		} else {
			// no op
		}
	}

	replace(initialFindInput?: string, initialReplaceInput?: string) {
		super.showWithReplace(initialFindInput, initialReplaceInput);
		this._state.change({ searchString: initialFindInput ?? '', replaceString: initialReplaceInput ?? '', isRevealed: true }, false);
		this._replaceInput.select();

		if (this._showTimeout === null) {
			if (this._hideTimeout !== null) {
				window.clearTimeout(this._hideTimeout);
				this._hideTimeout = null;
				this._notebookEditor.removeClassName(FIND_HIDE_TRANSITION);
			}

			this._notebookEditor.addClassName(FIND_SHOW_TRANSITION);
			this._showTimeout = window.setTimeout(() => {
				this._notebookEditor.removeClassName(FIND_SHOW_TRANSITION);
				this._showTimeout = null;
			}, 200);
		} else {
			// no op
		}
	}

	override hide() {
		super.hide();
		this._state.change({ isRevealed: false }, false);
		this._findModel.clear();
		this._notebookEditor.findStop();
		this._progressBar.stop();

		if (this._hideTimeout === null) {
			if (this._showTimeout !== null) {
				window.clearTimeout(this._showTimeout);
				this._showTimeout = null;
				this._notebookEditor.removeClassName(FIND_SHOW_TRANSITION);
			}
			this._notebookEditor.addClassName(FIND_HIDE_TRANSITION);
			this._hideTimeout = window.setTimeout(() => {
				this._notebookEditor.removeClassName(FIND_HIDE_TRANSITION);
			}, 200);
		} else {
			// no op
		}

		if (this._previousFocusElement && this._previousFocusElement.offsetParent) {
			this._previousFocusElement.focus();
			this._previousFocusElement = undefined;
		}

		if (this._notebookEditor.hasModel()) {
			for (let i = 0; i < this._notebookEditor.getLength(); i++) {
				const cell = this._notebookEditor.cellAt(i);

				if (cell.getEditState() === CellEditState.Editing && cell.editStateSource === 'find') {
					cell.updateEditState(CellEditState.Preview, 'find');
				}
			}
		}
	}

	override _updateMatchesCount(): void {
		if (!this._findModel || !this._findModel.findMatches) {
			return;
		}

		this._matchesCount.style.minWidth = MAX_MATCHES_COUNT_WIDTH + 'px';
		this._matchesCount.title = '';

		// remove previous content
		if (this._matchesCount.firstChild) {
			this._matchesCount.removeChild(this._matchesCount.firstChild);
		}

		let label: string;

		if (this._state.matchesCount > 0) {
			let matchesCount: string = String(this._state.matchesCount);
			if (this._state.matchesCount >= MATCHES_LIMIT) {
				matchesCount += '+';
			}
			const matchesPosition: string = this._findModel.currentMatch < 0 ? '?' : String((this._findModel.currentMatch + 1));
			label = strings.format(NLS_MATCHES_LOCATION, matchesPosition, matchesCount);
		} else {
			label = NLS_NO_RESULTS;
		}

		this._matchesCount.appendChild(document.createTextNode(label));

		alertFn(this._getAriaLabel(label, this._state.currentMatch, this._state.searchString));
		MAX_MATCHES_COUNT_WIDTH = Math.max(MAX_MATCHES_COUNT_WIDTH, this._matchesCount.clientWidth);
	}

	private _getAriaLabel(label: string, currentMatch: Range | null, searchString: string): string {
		if (label === NLS_NO_RESULTS) {
			return searchString === ''
				? localize('ariaSearchNoResultEmpty', "{0} found", label)
				: localize('ariaSearchNoResult', "{0} found for '{1}'", label, searchString);
		}

		// TODO@rebornix, aria for `cell ${index}, line {line}`
		return localize('ariaSearchNoResultWithLineNumNoCurrentMatch', "{0} found for '{1}'", label, searchString);
	}
	override dispose() {
		this._notebookEditor?.removeClassName(FIND_SHOW_TRANSITION);
		this._notebookEditor?.removeClassName(FIND_HIDE_TRANSITION);
		this._findModel.dispose();
		super.dispose();
	}
}

registerNotebookContribution(NotebookFindWidget.id, NotebookFindWidget);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'notebook.hideFind',
			title: { value: localize('notebookActions.hideFind', "Hide Find in Notebook"), original: 'Hide Find in Notebook' },
			keybinding: {
				when: ContextKeyExpr.and(NOTEBOOK_EDITOR_FOCUSED, KEYBINDING_CONTEXT_NOTEBOOK_FIND_WIDGET_FOCUSED),
				primary: KeyCode.Escape,
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editor = getNotebookEditorFromEditorPane(editorService.activeEditorPane);

		if (!editor) {
			return;
		}

		const controller = editor.getContribution<NotebookFindWidget>(NotebookFindWidget.id);
		controller.hide();
		editor.focus();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'notebook.find',
			title: { value: localize('notebookActions.findInNotebook', "Find in Notebook"), original: 'Find in Notebook' },
			keybinding: {
				when: ContextKeyExpr.and(NOTEBOOK_EDITOR_FOCUSED, NOTEBOOK_IS_ACTIVE_EDITOR, EditorContextKeys.focus.toNegated()),
				primary: KeyCode.KeyF | KeyMod.CtrlCmd,
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editor = getNotebookEditorFromEditorPane(editorService.activeEditorPane);

		if (!editor) {
			return;
		}

		const controller = editor.getContribution<NotebookFindWidget>(NotebookFindWidget.id);
		controller.show();
	}
});

StartFindAction.addImplementation(100, (accessor: ServicesAccessor, codeEditor: ICodeEditor, args: any) => {
	const editorService = accessor.get(IEditorService);
	const editor = getNotebookEditorFromEditorPane(editorService.activeEditorPane);

	if (!editor) {
		return false;
	}

	if (!editor.hasEditorFocus() && !editor.hasWebviewFocus()) {
		return false;
	}

	const controller = editor.getContribution<NotebookFindWidget>(NotebookFindWidget.id);
	controller.show();
	return true;
});

StartFindReplaceAction.addImplementation(100, (accessor: ServicesAccessor, codeEditor: ICodeEditor, args: any) => {
	const editorService = accessor.get(IEditorService);
	const editor = getNotebookEditorFromEditorPane(editorService.activeEditorPane);

	if (!editor) {
		return false;
	}

	const controller = editor.getContribution<NotebookFindWidget>(NotebookFindWidget.id);
	if (controller) {
		controller.replace();
		return true;
	}

	return false;
});
