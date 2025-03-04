/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ITransaction, IObservable, observableValue, autorun, transaction, ObservablePromise } from '../../../../../base/common/observable.js';
import { ObservableDisposable } from '../../../../../base/common/observableDisposable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { themeColorFromId } from '../../../../../base/common/themables.js';
import { assertType } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { EditOperation, ISingleEditOperation } from '../../../../../editor/common/core/editOperation.js';
import { LineRange } from '../../../../../editor/common/core/lineRange.js';
import { OffsetEdit } from '../../../../../editor/common/core/offsetEdit.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IDocumentDiff, nullDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { DetailedLineRangeMapping, RangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { IModelDeltaDecoration, ITextModel, MinimapPosition, OverviewRulerLane } from '../../../../../editor/common/model.js';
import { SingleModelEditStackElement } from '../../../../../editor/common/model/editStack.js';
import { ModelDecorationOptions } from '../../../../../editor/common/model/textModel.js';
import { OffsetEdits } from '../../../../../editor/common/model/textModelOffsetEdit.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IModelContentChangedEvent } from '../../../../../editor/common/textModelEvents.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { observableConfigValue } from '../../../../../platform/observable/common/platformObservableUtils.js';
import { editorSelectionBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { IUndoRedoElement, IUndoRedoService } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { IEditorPane, SaveReason } from '../../../../common/editor.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { SnapshotContext } from '../../../../services/workingCopy/common/fileWorkingCopy.js';
import { NotebookTextDiffEditor } from '../../../notebook/browser/diff/notebookDiffEditor.js';
import { INotebookTextDiffEditor } from '../../../notebook/browser/diff/notebookDiffEditorBrowser.js';
import { CellDiffInfo } from '../../../notebook/browser/diff/notebookDiffViewModel.js';
import { CellEditState, getNotebookEditorFromEditorPane } from '../../../notebook/browser/notebookBrowser.js';
import { INotebookEditorService } from '../../../notebook/browser/services/notebookEditorService.js';
import { NotebookCellTextModel } from '../../../notebook/common/model/notebookCellTextModel.js';
import { NotebookTextModel } from '../../../notebook/common/model/notebookTextModel.js';
import { CellEditType, ICell, ICellDto2, ICellEditOperation, ICellReplaceEdit, IResolvedNotebookEditorModel, NotebookCellsChangeType, NotebookCellsModelMoveEvent, NotebookCellTextModelSplice, NotebookTextModelChangedEvent, TransientOptions } from '../../../notebook/common/notebookCommon.js';
import { computeDiff } from '../../../notebook/common/notebookDiff.js';
import { INotebookEditorModelResolverService } from '../../../notebook/common/notebookEditorModelResolverService.js';
import { INotebookLoggingService } from '../../../notebook/common/notebookLoggingService.js';
import { INotebookService } from '../../../notebook/common/notebookService.js';
import { INotebookEditorWorkerService } from '../../../notebook/common/services/notebookWorkerService.js';
import { ChatEditKind, IModifiedFileEntryEditorIntegration, WorkingSetEntryState } from '../../common/chatEditingService.js';
import { IChatResponseModel } from '../../common/chatModel.js';
import { IChatService } from '../../common/chatService.js';
import { AbstractChatEditingModifiedFileEntry, IModifiedEntryTelemetryInfo, ISnapshotEntry, pendingRewriteMinimap } from './chatEditingModifiedFileEntry.js';
import { createSnapshot, deserializeSnapshot, getNotebookSnapshotFileURI, restoreSnapshot, SnapshotComparer } from './chatEditingModifiedNotebookSnapshot.js';
import { ChatEditingNotebookDiffEditorIntegration, ChatEditingNotebookEditorIntegration, countChanges, ICellDiffInfo, sortCellChanges } from './chatEditingNotebookEditorIntegration.js';
import { ChatEditingNotebookFileSystemProvider } from './chatEditingNotebookFileSystemProvider.js';


const SnapshotLanguageId = 'VSCodeChatNotebookSnapshotLanguage';

export class ChatEditingModifiedNotebookEntry extends AbstractChatEditingModifiedFileEntry {
	static NewModelCounter: number = 0;
	private readonly modifiedModel: NotebookTextModel;
	private readonly originalModel: NotebookTextModel;
	override originalURI: URI;
	/**
	 * JSON stringified version of the original notebook.
	 */
	override initialContent: string;
	/**
	 * Whether we're in the process of applying edits.
	 */
	private _isEditFromUs: boolean = false;
	/**
	 * Whether all edits are from us, e.g. is possible a user has made edits, then this will be false.
	 */
	private _allEditsAreFromUs: boolean = true;
	private readonly _changesCount = observableValue<number>(this, 0);
	override changesCount: IObservable<number> = this._changesCount;

	private readonly cellEntryMap = new ResourceMap<ChatEditingNotebookCellEntry>();
	private modifiedToOriginalCell = new ResourceMap<URI>();
	private readonly _cellsDiffInfo = observableValue<ICellDiffInfo[]>('diffInfo', []);
	private readonly _maxModifiedLineNumbers = observableValue<number[]>('changedMaxLineNumber', []);

	get cellsDiffInfo(): IObservable<ICellDiffInfo[]> {
		return this._cellsDiffInfo;
	}

	/**
	 * List of Cell URIs that are edited,
	 * Will be cleared once all edits have been accepted.
	 * I.e. this will only contain URIS while acceptAgentEdits is being called & before `isLastEdit` is sent.
	 * I.e. this is populated only when edits are being streamed.
	 */
	private readonly editedCells = new ResourceSet();

	public static async create(uri: URI, _multiDiffEntryDelegate: { collapse: (transaction: ITransaction | undefined) => void }, telemetryInfo: IModifiedEntryTelemetryInfo, chatKind: ChatEditKind, initialContent: string | undefined, instantiationService: IInstantiationService): Promise<AbstractChatEditingModifiedFileEntry> {
		return instantiationService.invokeFunction(async accessor => {
			const notebookService = accessor.get(INotebookService);
			const resolver = accessor.get(INotebookEditorModelResolverService);
			const configurationServie = accessor.get(IConfigurationService);
			const resourceRef: IReference<IResolvedNotebookEditorModel> = await resolver.resolve(uri);
			const notebook = resourceRef.object.notebook;
			const originalUri = getNotebookSnapshotFileURI(telemetryInfo.sessionId, telemetryInfo.requestId, generateUuid(), notebook.uri.scheme === Schemas.untitled ? `/${notebook.uri.path}` : notebook.uri.path, notebook.viewType);
			const [options, buffer] = await Promise.all([
				notebookService.withNotebookDataProvider(resourceRef.object.notebook.notebookType),
				notebookService.createNotebookTextDocumentSnapshot(notebook.uri, SnapshotContext.Backup, CancellationToken.None).then(s => streamToBuffer(s))
			]);
			const disposables = new DisposableStore();
			// Register so that we can load this from file system.
			disposables.add(ChatEditingNotebookFileSystemProvider.registerFile(originalUri, buffer));
			const originalRef = await resolver.resolve(originalUri, notebook.viewType);
			if (initialContent) {
				restoreSnapshot(originalRef.object.notebook, initialContent);
			} else {
				// Both models are the same, ensure the cell ids are the same, this way we get a perfect diffing.
				// No need to generate edits for this.
				const edits: ICellEditOperation[] = [];
				notebook.cells.forEach((cell, index) => {
					const cellId = cell.internalMetadata?.cellId;
					if (cellId) {
						edits.push({ editType: CellEditType.PartialInternalMetadata, index, internalMetadata: { cellId } });
					}
				});
				originalRef.object.notebook.applyEdits(edits, true, undefined, () => undefined, undefined, false);

			}
			initialContent = initialContent || createSnapshot(originalRef.object.notebook, options.serializer.options, configurationServie);
			const instance = instantiationService.createInstance(ChatEditingModifiedNotebookEntry, resourceRef, originalRef, _multiDiffEntryDelegate, options.serializer.options, telemetryInfo, chatKind, initialContent);
			instance._register(disposables);
			return instance;
		});
	}

	public static canHandleSnapshotContent(initialContent: string | undefined): boolean {
		if (!initialContent) {
			return false;
		}

		try {
			deserializeSnapshot(initialContent);
			return true;
		} catch (ex) {
			// not a valid snapshot
			return false;
		}
	}

	public static canHandleSnapshot(snapshot: ISnapshotEntry): boolean {
		if (snapshot.languageId === SnapshotLanguageId && ChatEditingModifiedNotebookEntry.canHandleSnapshotContent(snapshot.current)) {
			return true;
		}
		return false;
	}

	private readonly initialContentComparer: SnapshotComparer;

	constructor(
		private readonly modifiedResourceRef: IReference<IResolvedNotebookEditorModel>,
		originalResourceRef: IReference<IResolvedNotebookEditorModel>,
		private readonly _multiDiffEntryDelegate: { collapse: (transaction: ITransaction | undefined) => void },
		private readonly transientOptions: TransientOptions | undefined,
		telemetryInfo: IModifiedEntryTelemetryInfo,
		kind: ChatEditKind,
		initialContent: string,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFilesConfigurationService fileConfigService: IFilesConfigurationService,
		@IChatService chatService: IChatService,
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@IUndoRedoService undoRedoService: IUndoRedoService,
		@INotebookEditorWorkerService private readonly notebookEditorWorkerService: INotebookEditorWorkerService,
		@INotebookLoggingService private readonly loggingService: INotebookLoggingService,
	) {
		super(modifiedResourceRef.object.notebook.uri, telemetryInfo, kind, configurationService, fileConfigService, chatService, fileService, undoRedoService, instantiationService);
		this.initialContentComparer = new SnapshotComparer(initialContent);
		this.modifiedModel = this._register(modifiedResourceRef).object.notebook;
		this.originalModel = this._register(originalResourceRef).object.notebook;
		this.originalURI = this.originalModel.uri;
		this.initialContent = initialContent;
		this._maxModifiedLineNumbers.set(this.modifiedModel.cells.map(() => 0), undefined);
		this.initializeModelsFromDiff();
		this._register(this.modifiedModel.onDidChangeContent(this.mirrorNotebookEdits, this));
	}

	initializeModelsFromDiffImpl(cellsDiffInfo: CellDiffInfo[]) {
		this.cellEntryMap.forEach(entry => entry.dispose());
		this.cellEntryMap.clear();
		const diffs = cellsDiffInfo.map((cellDiff, i) => {
			switch (cellDiff.type) {
				case 'delete':
					return this.createDeleteCellDiffInfo(cellDiff.originalCellIndex);
				case 'insert': {
					return this.createInsertedCellDiffInfo(cellDiff.modifiedCellIndex);
				}
				default:
					return this.createModifiedCellDiffInfo(cellDiff.modifiedCellIndex, cellDiff.originalCellIndex);
			}
		});
		this._cellsDiffInfo.set(diffs, undefined);
		this._changesCount.set(countChanges(diffs), undefined);
	}

	private computeRequestId: number = 0;
	async initializeModelsFromDiff() {
		if (this._areOriginalAndModifiedIdenticalImpl()) {
			const cellsDiffInfo: CellDiffInfo[] = this.modifiedModel.cells.map((_, index) => {
				return { type: 'unchanged', originalCellIndex: index, modifiedCellIndex: index } satisfies CellDiffInfo;
			});
			this.initializeModelsFromDiffImpl(cellsDiffInfo);
			return;
		}
		const id = ++this.computeRequestId;
		const cellsDiffInfo: CellDiffInfo[] = [];
		try {
			const notebookDiff = await this.notebookEditorWorkerService.computeDiff(this.originalURI, this.modifiedURI);
			if (id !== this.computeRequestId) {
				return;
			}
			const result = computeDiff(this.originalModel, this.modifiedModel, notebookDiff);
			if (result.cellDiffInfo.length) {
				cellsDiffInfo.push(...result.cellDiffInfo);
			}
		} catch (ex) {
			this.loggingService.error('Notebook Chat', 'Error computing diff:\n' + ex);
		}
		this.initializeModelsFromDiffImpl(cellsDiffInfo);
	}
	updateCellDiffInfo(cellsDiffInfo: ICellDiffInfo[], transcation: ITransaction | undefined) {
		this._cellsDiffInfo.set(sortCellChanges(cellsDiffInfo), transcation);
		this._changesCount.set(countChanges(cellsDiffInfo), transcation);

	}

	mirrorNotebookEdits(e: NotebookTextModelChangedEvent) {
		if (this._isEditFromUs || Array.from(this.cellEntryMap.values()).some(entry => entry.isEditFromUs)) {
			return;
		}

		// Possible user reverted the changes from SCM or the like.
		// Or user just reverted the changes made via edits (e.g. edit made a change in a cell and user undid that change either by typing over or other).
		// Computing snapshot is too slow, as this event gets triggered for every key stroke in a cell,
		// const didResetToOriginalContent = createSnapshot(this.modifiedModel, this.transientOptions, this.configurationService) === this.initialContent;
		const didResetToOriginalContent = this.initialContentComparer.isEqual(this.modifiedModel);
		const currentState = this._stateObs.get();
		if (currentState === WorkingSetEntryState.Rejected) {
			return;
		}
		if (currentState === WorkingSetEntryState.Modified && didResetToOriginalContent) {
			this._stateObs.set(WorkingSetEntryState.Rejected, undefined);
			this.updateCellDiffInfo([], undefined);
			return;
		}

		if (!e.rawEvents.length) {
			return;
		}

		this._allEditsAreFromUs = false;

		// Changes to cell text is sync'ed and handled separately.
		// See ChatEditingNotebookCellEntry._mirrorEdits
		for (const event of e.rawEvents.filter(event => event.kind !== NotebookCellsChangeType.ChangeCellContent)) {
			switch (event.kind) {
				case NotebookCellsChangeType.ChangeDocumentMetadata: {
					const edit: ICellEditOperation = {
						editType: CellEditType.DocumentMetadata,
						metadata: this.modifiedModel.metadata
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.ModelChange: {
					let cellDiffs = sortCellChanges(this._cellsDiffInfo.get()).slice();
					event.changes.forEach(change => {
						cellDiffs = adjustCellDiffAndOriginalModelBasedOnCellAddDelete(change,
							cellDiffs,
							this.modifiedModel.cells.length,
							this.originalModel.cells.length,
							this.originalModel.applyEdits.bind(this.originalModel),
							this.createModifiedCellDiffInfo.bind(this));
					});
					this.updateCellDiffInfo(cellDiffs, undefined);
					this.disposeDeletedCellEntries();
					break;
				}
				case NotebookCellsChangeType.ChangeCellLanguage: {
					const edit: ICellEditOperation = {
						editType: CellEditType.CellLanguage,
						index: event.index,
						language: event.language
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.ChangeCellMetadata: {
					const edit: ICellEditOperation = {
						editType: CellEditType.Metadata,
						index: event.index,
						metadata: event.metadata
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.ChangeCellMime:
					break;
				case NotebookCellsChangeType.ChangeCellInternalMetadata: {
					const edit: ICellEditOperation = {
						editType: CellEditType.PartialInternalMetadata,
						index: event.index,
						internalMetadata: event.internalMetadata
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.Output: {
					const edit: ICellEditOperation = {
						editType: CellEditType.Output,
						index: event.index,
						append: event.append,
						outputs: event.outputs
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.OutputItem: {
					const edit: ICellEditOperation = {
						editType: CellEditType.OutputItems,
						outputId: event.outputId,
						append: event.append,
						items: event.outputItems
					};
					this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
					break;
				}
				case NotebookCellsChangeType.Move: {
					const result = adjustCellDiffAndOriginalModelBasedOnCellMovements(event, this._cellsDiffInfo.get().slice());
					if (result) {
						this.originalModel.applyEdits(result[1], true, undefined, () => undefined, undefined, true);
						this._cellsDiffInfo.set(result[0], undefined);
					}
					break;
				}
				default: {
					break;
				}
			}
		}
	}

	protected override async _doAccept(tx: ITransaction | undefined): Promise<void> {
		this.updateCellDiffInfo([], tx);
		const snapshot = createSnapshot(this.modifiedModel, this.transientOptions, this.configurationService);
		restoreSnapshot(this.originalModel, snapshot);
		this.initializeModelsFromDiff();
		await this._collapse(tx);
	}

	protected override async _doReject(tx: ITransaction | undefined): Promise<void> {
		this.updateCellDiffInfo([], tx);
		if (this.createdInRequestId === this._telemetryInfo.requestId) {
			await this._applyEdits(async () => {
				await this.modifiedResourceRef.object.revert({ soft: true });
				await this._fileService.del(this.modifiedURI);
			});
			this._onDidDelete.fire();
		} else {
			await this._applyEdits(async () => {
				const snapshot = createSnapshot(this.originalModel, this.transientOptions, this.configurationService);
				this.restoreSnapshotInModifiedModel(snapshot);
				if (this._allEditsAreFromUs && Array.from(this.cellEntryMap.values()).every(entry => entry.allEditsAreFromUs)) {
					// save the file after discarding so that the dirty indicator goes away
					// and so that an intermediate saved state gets reverted
					await this.modifiedResourceRef.object.save({ reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
				}
			});
			this.initializeModelsFromDiff();
			await this._collapse(tx);
		}
	}

	private async _collapse(transaction: ITransaction | undefined): Promise<void> {
		this._multiDiffEntryDelegate.collapse(transaction);
	}

	protected override _createEditorIntegration(editor: IEditorPane): IModifiedFileEntryEditorIntegration {
		const notebookEditor = getNotebookEditorFromEditorPane(editor);
		if (!notebookEditor && editor.getId() === NotebookTextDiffEditor.ID) {
			const diffEditor = (editor.getControl() as INotebookTextDiffEditor);
			return this._instantiationService.createInstance(ChatEditingNotebookDiffEditorIntegration, diffEditor, this._cellsDiffInfo);
		}
		assertType(notebookEditor);
		return this._instantiationService.createInstance(ChatEditingNotebookEditorIntegration, this, notebookEditor, this.modifiedModel, this.originalModel, this._cellsDiffInfo);
	}

	protected override _resetEditsState(tx: ITransaction): void {
		super._resetEditsState(tx);
		this.cellEntryMap.forEach(entry => !entry.disposed && entry.clearCurrentEditLineDecoration());
	}

	protected override _createUndoRedoElement(_response: IChatResponseModel): IUndoRedoElement | undefined {
		// TODO@amunger
		return undefined;
	}

	protected override async _areOriginalAndModifiedIdentical(): Promise<boolean> {
		return this._areOriginalAndModifiedIdenticalImpl();
	}

	private _areOriginalAndModifiedIdenticalImpl(): boolean {
		const snapshot = createSnapshot(this.originalModel, this.transientOptions, this.configurationService);
		return new SnapshotComparer(snapshot).isEqual(this.modifiedModel);
	}

	override async acceptAgentEdits(resource: URI, edits: (TextEdit | ICellEditOperation)[], isLastEdits: boolean, responseModel: IChatResponseModel): Promise<void> {
		const isCellUri = resource.scheme === Schemas.vscodeNotebookCell;
		const cell = isCellUri && this.modifiedModel.cells.find(cell => isEqual(cell.uri, resource));
		let cellEntry: ChatEditingNotebookCellEntry | undefined;
		if (cell) {
			const index = this.modifiedModel.cells.indexOf(cell);
			const entry = this._cellsDiffInfo.get().slice().find(entry => entry.modifiedCellIndex === index);
			if (!entry) {
				// Not possible.
				console.error('Original cell model not found');
				return;
			}

			cellEntry = this.getOrCreateModifiedTextFileEntryForCell(cell, await entry.modifiedModel.promise, await entry.originalModel.promise);
		}

		// For all cells that were edited, send the `isLastEdits` flag.
		const finishPreviousCells = () => {
			this.editedCells.forEach(uri => {
				const cell = this.modifiedModel.cells.find(cell => isEqual(cell.uri, uri));
				const cellEntry = cell && this.cellEntryMap.get(cell.uri);
				cellEntry?.acceptAgentEdits([], true, responseModel);
			});
			this.editedCells.clear();
		};

		await this._applyEdits(async () => {
			await Promise.all(edits.map(async edit => {
				if (TextEdit.isTextEdit(edit)) {
					if (!this.editedCells.has(resource)) {
						finishPreviousCells();
						this.editedCells.add(resource);
					}
					cellEntry?.acceptAgentEdits([edit], isLastEdits, responseModel);
				} else {
					this.acceptNotebookEdit(edit);
				}
			}));
		});

		// If the last edit for a cell was sent, then handle it
		if (isCellUri && isLastEdits) {
			finishPreviousCells();
		}

		// isLastEdits can be true for cell Uris, but when its true for Cells edits.
		// It cannot be true for the notebook itself.
		isLastEdits = !isCellUri && isLastEdits;

		transaction((tx) => {
			if (!isLastEdits) {
				this._stateObs.set(WorkingSetEntryState.Modified, tx);
				this._isCurrentlyBeingModifiedByObs.set(responseModel, tx);
				this._rewriteRatioObs.set(Math.min(1, this.calculateRewriteRadio()), tx);

			} else {
				finishPreviousCells();
				this.editedCells.clear();
				this._resetEditsState(tx);
				this._rewriteRatioObs.set(1, tx);
			}
		});
	}

	private disposeDeletedCellEntries() {
		const cellsUris = new ResourceSet(this.modifiedModel.cells.map(cell => cell.uri));
		Array.from(this.cellEntryMap.keys()).forEach(uri => {
			if (cellsUris.has(uri)) {
				return;
			}
			this.cellEntryMap.get(uri)?.dispose();
			this.cellEntryMap.delete(uri);
		});
	}

	acceptNotebookEdit(edit: ICellEditOperation): void {
		// make the actual edit
		this.modifiedModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
		this.disposeDeletedCellEntries();

		if (edit.editType !== CellEditType.Replace) {
			return;
		}
		if (edit.count === 0) {
			// All existing indexes are shifted by number of cells added.
			const diff = sortCellChanges(this._cellsDiffInfo.get()).slice();
			diff.forEach(d => {
				if (d.type !== 'delete' && d.modifiedCellIndex >= edit.index) {
					d.modifiedCellIndex += edit.cells.length;
				}
			});
			const diffInsert = edit.cells.map((_, i) => this.createInsertedCellDiffInfo(edit.index + i));
			diff.splice(edit.index + 1, 0, ...diffInsert);
			this.updateCellDiffInfo(diff, undefined);
		} else {
			// All existing indexes are shifted by number of cells removed.
			// And unchanged cells should be converted to deleted cells.
			const diff = sortCellChanges(this._cellsDiffInfo.get()).slice().map((d) => {
				if (d.type === 'unchanged' && d.modifiedCellIndex >= edit.index && d.modifiedCellIndex <= (edit.index + edit.count - 1)) {
					return this.createDeleteCellDiffInfo(d.originalCellIndex);
				}
				if (d.type !== 'delete' && d.modifiedCellIndex >= (edit.index + edit.count)) {
					d.modifiedCellIndex -= edit.count;
					return d;
				}
				return d;
			});
			this.updateCellDiffInfo(diff, undefined);
		}
	}

	private computeStateAfterAcceptingRejectingChanges(accepted: boolean) {
		const currentSnapshot = createSnapshot(this.modifiedModel, this.transientOptions, this.configurationService);
		if (new SnapshotComparer(currentSnapshot).isEqual(this.originalModel)) {
			const state = accepted ? WorkingSetEntryState.Accepted : WorkingSetEntryState.Rejected;
			this._stateObs.set(state, undefined);
		}
	}

	createModifiedCellDiffInfo(modifiedCellIndex: number, originalCellIndex: number): ICellDiffInfo {
		const modifiedCell = this.modifiedModel.cells[modifiedCellIndex];
		const originalCell = this.originalModel.cells[originalCellIndex];
		this.modifiedToOriginalCell.set(modifiedCell.uri, originalCell.uri);
		const modifiedCellModelPromise = this.resolveCellModel(modifiedCell.uri);
		const originalCellModelPromise = this.resolveCellModel(originalCell.uri);

		Promise.all([modifiedCellModelPromise, originalCellModelPromise]).then(([modifiedCellModel, originalCellModel]) => {
			this.getOrCreateModifiedTextFileEntryForCell(modifiedCell, modifiedCellModel, originalCellModel);
		});

		const diff = observableValue('diff', nullDocumentDiff);
		const unchangedCell: ICellDiffInfo = {
			type: 'unchanged',
			modifiedCellIndex,
			originalCellIndex,
			keep: async (changes: DetailedLineRangeMapping) => {
				const [modifiedCellModel, originalCellModel] = await Promise.all([modifiedCellModelPromise, originalCellModelPromise]);
				const entry = this.getOrCreateModifiedTextFileEntryForCell(modifiedCell, modifiedCellModel, originalCellModel);
				return entry ? entry.keep(changes) : false;
			},
			undo: async (changes: DetailedLineRangeMapping) => {
				const [modifiedCellModel, originalCellModel] = await Promise.all([modifiedCellModelPromise, originalCellModelPromise]);
				const entry = this.getOrCreateModifiedTextFileEntryForCell(modifiedCell, modifiedCellModel, originalCellModel);
				return entry ? entry.undo(changes) : false;
			},
			modifiedModel: new ObservablePromise(modifiedCellModelPromise),
			originalModel: new ObservablePromise(originalCellModelPromise),
			diff
		};

		return unchangedCell;

	}
	createInsertedCellDiffInfo(modifiedCellIndex: number): ICellDiffInfo {
		const cell = this.modifiedModel.cells[modifiedCellIndex];
		const lines = cell.getValue().split(/\r?\n/);
		const originalRange = new Range(1, 0, 1, 0);
		const modifiedRange = new Range(1, 0, lines.length, lines[lines.length - 1].length);
		const innerChanges = new RangeMapping(originalRange, modifiedRange);
		const changes = [new DetailedLineRangeMapping(new LineRange(1, 1), new LineRange(1, lines.length), [innerChanges])];
		// When a new cell is inserted, we use the ChatEditingCodeEditorIntegration to handle the edits.
		// & to also display undo/redo and decorations.
		// However that needs a modified and original model.
		// For inserted cells there's no original model, so we create a new empty text model and pass that as the original.
		const originalModelUri = this.modifiedModel.uri.with({ query: (ChatEditingModifiedNotebookEntry.NewModelCounter++).toString(), scheme: 'emptyCell' });
		const originalModel = this.modelService.getModel(originalModelUri) || this._register(this.modelService.createModel('', null, originalModelUri));
		this.modifiedToOriginalCell.set(cell.uri, originalModelUri);
		const keep = async () => {
			await this._applyEdits(async () => this.keepPreviouslyInsertedCell(cell));
			this.computeStateAfterAcceptingRejectingChanges(true);
			return true;
		};
		const undo = async () => {
			await this._applyEdits(async () => this.undoPreviouslyInsertedCell(cell));
			this.computeStateAfterAcceptingRejectingChanges(false);
			return true;
		};
		this.resolveCellModel(cell.uri).then(modifiedModel => {
			// We want decorators for the cell just as we display decorators for modified cells.
			// This way we have the ability to accept/reject the entire cell.
			this.getOrCreateModifiedTextFileEntryForCell(cell, modifiedModel, originalModel);
		});
		return {
			type: 'insert' as const,
			originalCellIndex: undefined,
			modifiedCellIndex: modifiedCellIndex,
			keep,
			undo,
			modifiedModel: new ObservablePromise(this.resolveCellModel(cell.uri)),
			originalModel: new ObservablePromise(Promise.resolve(originalModel)),
			diff: observableValue('deletedCellDiff', {
				changes,
				identical: false,
				moves: [],
				quitEarly: false,
			})
		} satisfies ICellDiffInfo;
	}
	createDeleteCellDiffInfo(originalCellIndex: number): ICellDiffInfo {
		const originalCell = this.originalModel.cells[originalCellIndex];
		const lines = new Array(originalCell.textBuffer.getLineCount()).fill(0).map((_, i) => originalCell.textBuffer.getLineContent(i + 1));
		const originalRange = new Range(1, 0, lines.length, lines[lines.length - 1].length);
		const modifiedRange = new Range(1, 0, 1, 0);
		const innerChanges = new RangeMapping(modifiedRange, originalRange);
		const changes = [new DetailedLineRangeMapping(new LineRange(1, lines.length), new LineRange(1, 1), [innerChanges])];
		const modifiedModelUri = this.modifiedModel.uri.with({ query: (ChatEditingModifiedNotebookEntry.NewModelCounter++).toString(), scheme: 'emptyCell' });
		const modifiedModel = this.modelService.getModel(modifiedModelUri) || this._register(this.modelService.createModel('', null, modifiedModelUri));
		const keep = async () => {
			await this._applyEdits(async () => this.keepPreviouslyDeletedCell(this.originalModel.cells.indexOf(originalCell)));
			this.computeStateAfterAcceptingRejectingChanges(true);
			return true;
		};
		const undo = async () => {
			await this._applyEdits(async () => this.undoPreviouslyDeletedCell(this.originalModel.cells.indexOf(originalCell), originalCell));
			this.computeStateAfterAcceptingRejectingChanges(false);
			return true;
		};

		// This will be deleted.
		return {
			type: 'delete' as const,
			modifiedCellIndex: undefined,
			originalCellIndex,
			originalModel: new ObservablePromise(this.resolveCellModel(originalCell.uri)),
			modifiedModel: new ObservablePromise(Promise.resolve(modifiedModel)),
			keep,
			undo,
			diff: observableValue('cellDiff', {
				changes,
				identical: false,
				moves: [],
				quitEarly: false,
			})
		} satisfies ICellDiffInfo;
	}

	private undoPreviouslyInsertedCell(cell: NotebookCellTextModel) {
		const index = this.modifiedModel.cells.indexOf(cell);
		const diffs = adjustCellDiffForRevertingAnInsertedCell(index,
			this._cellsDiffInfo.get(),
			this.modifiedModel.applyEdits.bind(this.modifiedModel));
		this.disposeDeletedCellEntries();
		this.updateCellDiffInfo(diffs, undefined);
	}

	private keepPreviouslyInsertedCell(cell: NotebookCellTextModel) {
		const modifiedCellIndex = this.modifiedModel.cells.indexOf(cell);
		if (modifiedCellIndex === -1) {
			// Not possible.
			return;
		}
		const cellToInsert: ICellDto2 = {
			cellKind: cell.cellKind,
			language: cell.language,
			metadata: cell.metadata,
			outputs: cell.outputs,
			source: cell.getValue(),
			mime: cell.mime,
			internalMetadata: {
				cellId: cell.internalMetadata.cellId
			}
		};
		this.cellEntryMap.get(cell.uri)?.dispose();
		this.cellEntryMap.delete(cell.uri);
		const cellDiffs = adjustCellDiffForKeepingAnInsertedCell(
			modifiedCellIndex,
			this._cellsDiffInfo.get().slice(),
			cellToInsert,
			this.originalModel.applyEdits.bind(this.originalModel),
			this.createModifiedCellDiffInfo.bind(this)
		);
		this.updateCellDiffInfo(cellDiffs, undefined);
	}

	private undoPreviouslyDeletedCell(deletedOriginalIndex: number, originalCell: NotebookCellTextModel) {
		const cellToInsert: ICellDto2 = {
			cellKind: originalCell.cellKind,
			language: originalCell.language,
			metadata: originalCell.metadata,
			outputs: originalCell.outputs,
			source: originalCell.getValue(),
			mime: originalCell.mime,
			internalMetadata: {
				cellId: originalCell.internalMetadata.cellId
			}
		};
		const cellDiffs = adjustCellDiffForRevertingADeletedCell(
			deletedOriginalIndex,
			this._cellsDiffInfo.get(),
			cellToInsert,
			this.modifiedModel.applyEdits.bind(this.modifiedModel),
			this.createModifiedCellDiffInfo.bind(this)
		);
		this.updateCellDiffInfo(cellDiffs, undefined);
	}


	private keepPreviouslyDeletedCell(deletedOriginalIndex: number) {
		// Delete this cell from original as well.
		const edit: ICellReplaceEdit = { cells: [], count: 1, editType: CellEditType.Replace, index: deletedOriginalIndex, };
		this.originalModel.applyEdits([edit], true, undefined, () => undefined, undefined, true);
		const diffs = sortCellChanges(this._cellsDiffInfo.get()).slice()
			.filter(d => !(d.type === 'delete' && d.originalCellIndex === deletedOriginalIndex))
			.map(diff => {
				if (diff.type !== 'insert' && diff.originalCellIndex > deletedOriginalIndex) {
					return {
						...diff,
						originalCellIndex: diff.originalCellIndex - 1,
					};
				}
				return diff;
			});
		this.updateCellDiffInfo(diffs, undefined);
	}

	private async _applyEdits(operation: () => Promise<void>) {
		// make the actual edit
		this._isEditFromUs = true;
		try {
			await operation();
		} finally {
			this._isEditFromUs = false;
		}
	}

	calculateRewriteRadio() {
		const cellChanges = this._cellsDiffInfo.get();
		const totalNumberOfUpdatedLines = cellChanges.reduce((totalUpdatedLines, value) => {
			const getUpadtedLineCount = () => {
				if (value.type === 'unchanged') {
					return 0;
				}
				if (value.type === 'delete') {
					return this.originalModel.cells[value.originalCellIndex].textModel?.getLineCount() ?? 0;
				}
				if (value.type === 'insert') {
					return this.modifiedModel.cells[value.modifiedCellIndex].textModel?.getLineCount() ?? 0;
				}
				return value.diff.get().changes.reduce((maxLineNumber, change) => {
					return Math.max(maxLineNumber, change.modified.endLineNumberExclusive);
				}, 0);
			};

			return totalUpdatedLines + getUpadtedLineCount();
		}, 0);

		const totalNumberOfLines = this.modifiedModel.cells.reduce((totalLines, cell) => totalLines + (cell.textModel?.getLineCount() ?? 0), 0);
		return totalNumberOfLines === 0 ? 0 : Math.min(1, totalNumberOfUpdatedLines / totalNumberOfLines);
	}

	override createSnapshot(requestId: string | undefined, undoStop: string | undefined): ISnapshotEntry {
		this.cellEntryMap.forEach(entry => entry.isFirstEditAfterStartOrSnapshot = true);
		return {
			resource: this.modifiedURI,
			languageId: SnapshotLanguageId,
			snapshotUri: getNotebookSnapshotFileURI(this._telemetryInfo.sessionId, requestId, undoStop, this.modifiedURI.path, this.modifiedModel.viewType),
			original: createSnapshot(this.originalModel, this.transientOptions, this.configurationService),
			current: createSnapshot(this.modifiedModel, this.transientOptions, this.configurationService),
			originalToCurrentEdit: OffsetEdit.empty,
			state: this.state.get(),
			telemetryInfo: this.telemetryInfo,
		};
	}

	override equalsSnapshot(snapshot: ISnapshotEntry | undefined): boolean {
		return !!snapshot &&
			this.modifiedURI.toString() === snapshot.resource.toString() &&
			this.state.get() === snapshot.state &&
			new SnapshotComparer(snapshot.original).isEqual(this.originalModel) &&
			new SnapshotComparer(snapshot.current).isEqual(this.modifiedModel);

	}

	override restoreFromSnapshot(snapshot: ISnapshotEntry): void {
		this.updateCellDiffInfo([], undefined);
		this._stateObs.set(snapshot.state, undefined);
		restoreSnapshot(this.originalModel, snapshot.original);
		this.restoreSnapshotInModifiedModel(snapshot.current);
		this.initializeModelsFromDiff();
	}

	override resetToInitialContent(): void {
		this.updateCellDiffInfo([], undefined);
		this.restoreSnapshotInModifiedModel(this.initialContent);
		this.initializeModelsFromDiff();
	}

	private restoreSnapshotInModifiedModel(snapshot: string) {
		if (snapshot === createSnapshot(this.modifiedModel, this.transientOptions, this.configurationService)) {
			return;
		}

		this._applyEdits(async () => {
			// See private _setDocValue in chatEditingModifiedDocumentEntry.ts
			this.modifiedModel.pushStackElement();
			restoreSnapshot(this.modifiedModel, snapshot);
			this.modifiedModel.pushStackElement();
		});
	}

	private async resolveCellModel(cellURI: URI): Promise<ITextModel> {
		const cell = this.originalModel.cells.concat(this.modifiedModel.cells).find(cell => isEqual(cell.uri, cellURI));
		if (!cell) {
			throw new Error('Cell not found');
		}
		if (cell.textModel) {
			return cell.textModel;
		}
		return this._register(await this.textModelService.createModelReference(cell.uri)).object.textEditorModel;
	}

	getOrCreateModifiedTextFileEntryForCell(cell: NotebookCellTextModel, modifiedCellModel: ITextModel, originalCellModel: ITextModel): ChatEditingNotebookCellEntry | undefined {
		let cellEntry = this.cellEntryMap.get(cell.uri);
		if (cellEntry) {
			return cellEntry;
		}

		const disposables = this._register(new DisposableStore());
		cellEntry = this._register(this._instantiationService.createInstance(ChatEditingNotebookCellEntry, this.modifiedResourceRef.object.resource, cell, modifiedCellModel, originalCellModel, this._telemetryInfo, disposables));
		this.cellEntryMap.set(cell.uri, cellEntry);
		disposables.add(autorun(r => {
			if (this.modifiedModel.cells.indexOf(cell) === -1) {
				return;
			}
			const diffs = this.cellsDiffInfo.get().slice();
			const index = this.modifiedModel.cells.indexOf(cell);
			const entry = diffs.find(entry => entry.modifiedCellIndex === index);
			if (!entry) {
				// Not possible.
				return;
			}
			entry.diff.set(cellEntry.diffInfo.read(r), undefined);
			diffs.splice(diffs.indexOf(entry), 1, { ...entry });
			const maxModifiedLineNumber = cellEntry.maxModifiedLineNumber.read(r);
			const maxModifiedLineNumbers = this._maxModifiedLineNumbers.get().slice();
			maxModifiedLineNumbers[index] = maxModifiedLineNumber;

			transaction(tx => {
				this.updateCellDiffInfo(diffs, tx);
				this._maxModifiedLineNumbers.set(maxModifiedLineNumbers, tx);
			});
		}));

		disposables.add(autorun(r => {
			if (this.modifiedModel.cells.indexOf(cell) === -1) {
				return;
			}

			const cellState = cellEntry.state.read(r);
			if (cellState === WorkingSetEntryState.Accepted) {
				this.computeStateAfterAcceptingRejectingChanges(true);
			} else if (cellState === WorkingSetEntryState.Rejected) {
				this.computeStateAfterAcceptingRejectingChanges(false);
			}
		}));

		return cellEntry;
	}
}

class ChatEditingNotebookCellEntry extends ObservableDisposable {
	private static readonly _lastEditDecorationOptions = ModelDecorationOptions.register({
		isWholeLine: true,
		description: 'chat-last-edit',
		className: 'chat-editing-last-edit-line',
		marginClassName: 'chat-editing-last-edit',
		overviewRuler: {
			position: OverviewRulerLane.Full,
			color: themeColorFromId(editorSelectionBackground)
		},
	});

	private static readonly _pendingEditDecorationOptions = ModelDecorationOptions.register({
		isWholeLine: true,
		description: 'chat-pending-edit',
		className: 'chat-editing-pending-edit',
		minimap: {
			position: MinimapPosition.Inline,
			color: themeColorFromId(pendingRewriteMinimap)
		}
	});


	private _isFirstEditAfterStartOrSnapshot: boolean = true;
	public set isFirstEditAfterStartOrSnapshot(value: boolean) {
		this._isFirstEditAfterStartOrSnapshot = value;
	}
	private _edit: OffsetEdit = OffsetEdit.empty;
	private _isEditFromUs: boolean = false;
	public get isEditFromUs(): boolean {
		return this._isEditFromUs;
	}

	private _allEditsAreFromUs: boolean = true;
	public get allEditsAreFromUs(): boolean {
		return this._allEditsAreFromUs;
	}
	private _diffOperation: Promise<any> | undefined;
	private _diffOperationIds: number = 0;

	private readonly _diffInfo = observableValue<IDocumentDiff>(this, nullDocumentDiff);
	public readonly changesCount: IObservable<number>;
	public get diffInfo(): IObservable<IDocumentDiff> {
		return this._diffInfo;
	}
	private readonly _maxModifiedLineNumber = observableValue<number>(this, 0);
	readonly maxModifiedLineNumber = this._maxModifiedLineNumber;

	private readonly _editDecorationClear = this._register(new RunOnceScheduler(() => { this._editDecorations = this.modifiedModel.deltaDecorations(this._editDecorations, []); }, 500));
	private _editDecorations: string[] = [];

	private readonly _diffTrimWhitespace: IObservable<boolean>;
	protected readonly _stateObs = observableValue<WorkingSetEntryState>(this, WorkingSetEntryState.Modified);
	readonly state: IObservable<WorkingSetEntryState> = this._stateObs;
	protected readonly _isCurrentlyBeingModifiedByObs = observableValue<IChatResponseModel | undefined>(this, undefined);
	readonly isCurrentlyBeingModifiedBy: IObservable<IChatResponseModel | undefined> = this._isCurrentlyBeingModifiedByObs;
	private readonly initialContent: string;

	constructor(
		public readonly notebookUri: URI,
		public readonly cell: NotebookCellTextModel,
		private readonly modifiedModel: ITextModel,
		private readonly originalModel: ITextModel,
		private readonly _telemetryInfo: IModifiedEntryTelemetryInfo,
		disposables: DisposableStore,
		@IConfigurationService configService: IConfigurationService,
		@IChatService private readonly _chatService: IChatService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IUndoRedoService private readonly _undoRedoService: IUndoRedoService,
		@INotebookEditorService private readonly notebookEditorService: INotebookEditorService
	) {
		super();
		this.initialContent = this.originalModel.getValue();
		this._register(disposables);
		this.changesCount = this._diffInfo.map(diff => diff.changes.length);
		this._register(this.modifiedModel.onDidChangeContent(e => {
			this._mirrorEdits(e);

		}));
		this._register(toDisposable(() => {
			this.clearCurrentEditLineDecoration();
		}));

		this._diffTrimWhitespace = observableConfigValue('diffEditor.ignoreTrimWhitespace', true, configService);
		this._register(autorun(r => {
			this._diffTrimWhitespace.read(r);
			this._updateDiffInfoSeq();
		}));
	}

	public clearCurrentEditLineDecoration() {
		if (this.modifiedModel.isDisposed()) {
			return;
		}
		this._editDecorations = this.modifiedModel.deltaDecorations(this._editDecorations, []);
	}


	private _mirrorEdits(event: IModelContentChangedEvent) {
		const edit = OffsetEdits.fromContentChanges(event.changes);

		if (this._isEditFromUs) {
			const e_sum = this._edit;
			const e_ai = edit;
			this._edit = e_sum.compose(e_ai);

		} else {

			//           e_ai
			//   d0 ---------------> s0
			//   |                   |
			//   |                   |
			//   | e_user_r          | e_user
			//   |                   |
			//   |                   |
			//   v       e_ai_r      v
			///  d1 ---------------> s1
			//
			// d0 - document snapshot
			// s0 - document
			// e_ai - ai edits
			// e_user - user edits
			//
			const e_ai = this._edit;
			const e_user = edit;

			const e_user_r = e_user.tryRebase(e_ai.inverse(this.originalModel.getValue()), true);

			if (e_user_r === undefined) {
				// user edits overlaps/conflicts with AI edits
				this._edit = e_ai.compose(e_user);
			} else {
				const edits = OffsetEdits.asEditOperations(e_user_r, this.originalModel);
				this.originalModel.applyEdits(edits);
				this._edit = e_ai.tryRebase(e_user_r);
			}

			this._allEditsAreFromUs = false;
			this._updateDiffInfoSeq();

			const didResetToOriginalContent = this.modifiedModel.getValue() === this.initialContent;
			const currentState = this._stateObs.get();
			switch (currentState) {
				case WorkingSetEntryState.Modified:
					if (didResetToOriginalContent) {
						this._stateObs.set(WorkingSetEntryState.Rejected, undefined);
						break;
					}
			}

		}
	}

	acceptAgentEdits(textEdits: TextEdit[], isLastEdits: boolean, responseModel: IChatResponseModel): void {
		const notebookEditor = this.notebookEditorService.retrieveExistingWidgetFromURI(this.notebookUri)?.value;
		if (notebookEditor) {
			const vm = notebookEditor.getCellByHandle(this.cell.handle);
			vm?.updateEditState(CellEditState.Editing, 'chatEdit');
		}

		// push stack element for the first edit
		if (this._isFirstEditAfterStartOrSnapshot) {
			this._isFirstEditAfterStartOrSnapshot = false;
			const request = this._chatService.getSession(this._telemetryInfo.sessionId)?.getRequests().at(-1);
			const label = request?.message.text ? localize('chatEditing1', "Chat Edit: '{0}'", request.message.text) : localize('chatEditing2', "Chat Edit");
			this._undoRedoService.pushElement(new SingleModelEditStackElement(label, 'chat.edit', this.modifiedModel, null));
		}

		const ops = textEdits.map(TextEdit.asEditOperation);
		const undoEdits = this._applyEdits(ops);

		const maxLineNumber = undoEdits.reduce((max, op) => Math.max(max, op.range.startLineNumber), 0);

		const newDecorations: IModelDeltaDecoration[] = [
			// decorate pending edit (region)
			{
				options: ChatEditingNotebookCellEntry._pendingEditDecorationOptions,
				range: new Range(maxLineNumber + 1, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
			}
		];

		if (maxLineNumber > 0) {
			// decorate last edit
			newDecorations.push({
				options: ChatEditingNotebookCellEntry._lastEditDecorationOptions,
				range: new Range(maxLineNumber, 1, maxLineNumber, Number.MAX_SAFE_INTEGER)
			});
		}

		this._editDecorations = this.modifiedModel.deltaDecorations(this._editDecorations, newDecorations);


		transaction((tx) => {
			if (!isLastEdits) {
				this._stateObs.set(WorkingSetEntryState.Modified, tx);
				this._isCurrentlyBeingModifiedByObs.set(responseModel, tx);
				this._maxModifiedLineNumber.set(maxLineNumber, tx);

			} else {
				this._resetEditsState(tx);
				this._updateDiffInfoSeq();
				this._maxModifiedLineNumber.set(0, tx);
				this._editDecorationClear.schedule();
			}
		});
	}

	scheduleEditDecorations() {
		this._editDecorationClear.schedule();
	}

	protected _resetEditsState(tx: ITransaction): void {
		this._isCurrentlyBeingModifiedByObs.set(undefined, tx);
		this._maxModifiedLineNumber.set(0, tx);
	}

	public async keep(change: DetailedLineRangeMapping): Promise<boolean> {
		return this._acceptHunk(change);
	}

	private async _acceptHunk(change: DetailedLineRangeMapping): Promise<boolean> {
		this._isEditFromUs = true;
		try {
			if (!this._diffInfo.get().changes.includes(change)) {
				// diffInfo should have model version ids and check them (instead of the caller doing that)
				return false;
			}
			const edits: ISingleEditOperation[] = [];
			for (const edit of change.innerChanges ?? []) {
				const newText = this.modifiedModel.getValueInRange(edit.modifiedRange);
				edits.push(EditOperation.replace(edit.originalRange, newText));
			}
			this.originalModel.pushEditOperations(null, edits, _ => null);
		}
		finally {
			this._isEditFromUs = false;
		}
		await this._updateDiffInfoSeq();
		if (this._diffInfo.get().identical) {
			this._stateObs.set(WorkingSetEntryState.Accepted, undefined);
		}
		return true;
	}

	public async undo(change: DetailedLineRangeMapping): Promise<boolean> {
		return this._rejectHunk(change);
	}

	private async _rejectHunk(change: DetailedLineRangeMapping): Promise<boolean> {
		this._isEditFromUs = true;
		try {
			if (!this._diffInfo.get().changes.includes(change)) {
				return false;
			}
			const edits: ISingleEditOperation[] = [];
			for (const edit of change.innerChanges ?? []) {
				const newText = this.originalModel.getValueInRange(edit.originalRange);
				edits.push(EditOperation.replace(edit.modifiedRange, newText));
			}
			this.modifiedModel.pushEditOperations(null, edits, _ => null);
		} finally {
			this._isEditFromUs = false;
		}
		await this._updateDiffInfoSeq();
		if (this._diffInfo.get().identical) {
			this._stateObs.set(WorkingSetEntryState.Rejected, undefined);
		}
		return true;
	}

	private _applyEdits(edits: ISingleEditOperation[]) {
		// make the actual edit
		this._isEditFromUs = true;
		try {
			let result: ISingleEditOperation[] = [];
			this.modifiedModel.pushEditOperations(null, edits, (undoEdits) => {
				result = undoEdits;
				return null;
			});
			return result;
		} finally {
			this._isEditFromUs = false;
		}
	}

	private async _updateDiffInfoSeq() {
		const myDiffOperationId = ++this._diffOperationIds;
		await Promise.resolve(this._diffOperation);
		if (this._diffOperationIds === myDiffOperationId) {
			const thisDiffOperation = this._updateDiffInfo();
			this._diffOperation = thisDiffOperation;
			await thisDiffOperation;
		}
	}

	private async _updateDiffInfo(): Promise<void> {

		if (this.originalModel.isDisposed() || this.modifiedModel.isDisposed()) {
			return;
		}

		const docVersionNow = this.modifiedModel.getVersionId();
		const snapshotVersionNow = this.originalModel.getVersionId();

		const ignoreTrimWhitespace = this._diffTrimWhitespace.get();

		const diff = await this._editorWorkerService.computeDiff(
			this.originalModel.uri,
			this.modifiedModel.uri,
			{ ignoreTrimWhitespace, computeMoves: false, maxComputationTimeMs: 3000 },
			'advanced'
		);

		if (this.originalModel.isDisposed() || this.modifiedModel.isDisposed()) {
			return;
		}

		// only update the diff if the documents didn't change in the meantime
		if (this.modifiedModel.getVersionId() === docVersionNow && this.originalModel.getVersionId() === snapshotVersionNow) {
			const diff2 = diff ?? nullDocumentDiff;
			this._diffInfo.set(diff2, undefined);
			this._edit = OffsetEdits.fromLineRangeMapping(this.originalModel, this.modifiedModel, diff2.changes);
		}
	}
}

export function adjustCellDiffForKeepingADeletedCell(originalCellIndex: number,
	cellDiffInfo: ICellDiffInfo[],
	applyEdits: typeof NotebookTextModel.prototype.applyEdits,
): ICellDiffInfo[] {
	// Delete this cell from original as well.
	const edit: ICellReplaceEdit = { cells: [], count: 1, editType: CellEditType.Replace, index: originalCellIndex, };
	applyEdits([edit], true, undefined, () => undefined, undefined, true);
	const diffs = sortCellChanges(cellDiffInfo)
		.filter(d => !(d.type === 'delete' && d.originalCellIndex === originalCellIndex))
		.map(diff => {
			if (diff.type !== 'insert' && diff.originalCellIndex > originalCellIndex) {
				return {
					...diff,
					originalCellIndex: diff.originalCellIndex - 1,
				};
			}
			return diff;
		});
	return diffs;
}

export function adjustCellDiffForRevertingADeletedCell(originalCellIndex: number,
	cellDiffInfo: ICellDiffInfo[],
	cellToInsert: ICellDto2,
	applyEdits: typeof NotebookTextModel.prototype.applyEdits,
	createModifiedCellDiffInfo: (modifiedCellIndex: number, originalCellIndex: number) => ICellDiffInfo,
): ICellDiffInfo[] {
	cellDiffInfo = sortCellChanges(cellDiffInfo);
	const indexOfEntry = cellDiffInfo.findIndex(d => d.originalCellIndex === originalCellIndex);
	if (indexOfEntry === -1) {
		// Not possible.
		return cellDiffInfo;
	}

	let modifiedCellIndex = -1;
	for (let i = 0; i < cellDiffInfo.length; i++) {
		const diff = cellDiffInfo[i];
		if (i < indexOfEntry) {
			modifiedCellIndex = Math.max(modifiedCellIndex, diff.modifiedCellIndex ?? modifiedCellIndex);
			continue;
		}
		if (i === indexOfEntry) {
			const edit: ICellReplaceEdit = { cells: [cellToInsert], count: 0, editType: CellEditType.Replace, index: modifiedCellIndex + 1, };
			applyEdits([edit], true, undefined, () => undefined, undefined, true);
			cellDiffInfo[i] = createModifiedCellDiffInfo(modifiedCellIndex + 1, originalCellIndex);
			continue;
		} else {
			// Increase the original index for all entries after this.
			if (typeof diff.modifiedCellIndex === 'number') {
				diff.modifiedCellIndex++;
				cellDiffInfo[i] = { ...diff };
			}
		}
	}

	return cellDiffInfo;
}

export function adjustCellDiffForRevertingAnInsertedCell(modifiedCellIndex: number,
	cellDiffInfo: ICellDiffInfo[],
	applyEdits: typeof NotebookTextModel.prototype.applyEdits,
): ICellDiffInfo[] {
	if (modifiedCellIndex === -1) {
		// Not possible.
		return cellDiffInfo;
	}
	cellDiffInfo = sortCellChanges(cellDiffInfo).map(d => {
		if (d.type === 'insert' && d.modifiedCellIndex === modifiedCellIndex) {
			return d;
		}
		if (d.type !== 'delete' && d.modifiedCellIndex > modifiedCellIndex) {
			return {
				...d,
				modifiedCellIndex: d.modifiedCellIndex - 1,
			};
		}
		return d;
	}).filter(d => !(d.type === 'insert' && d.modifiedCellIndex === modifiedCellIndex));
	const edit: ICellReplaceEdit = { cells: [], count: 1, editType: CellEditType.Replace, index: modifiedCellIndex, };
	applyEdits([edit], true, undefined, () => undefined, undefined, true);
	return cellDiffInfo;
}

export function adjustCellDiffForKeepingAnInsertedCell(modifiedCellIndex: number,
	cellDiffInfo: ICellDiffInfo[],
	cellToInsert: ICellDto2,
	applyEdits: typeof NotebookTextModel.prototype.applyEdits,
	createModifiedCellDiffInfo: (modifiedCellIndex: number, originalCellIndex: number) => ICellDiffInfo,
): ICellDiffInfo[] {
	cellDiffInfo = sortCellChanges(cellDiffInfo);
	if (modifiedCellIndex === -1) {
		// Not possible.
		return cellDiffInfo;
	}
	const indexOfEntry = cellDiffInfo.findIndex(d => d.modifiedCellIndex === modifiedCellIndex);
	if (indexOfEntry === -1) {
		// Not possible.
		return cellDiffInfo;
	}
	let originalCellIndex = -1;
	for (let i = 0; i < cellDiffInfo.length; i++) {
		const diff = cellDiffInfo[i];
		if (i < indexOfEntry) {
			originalCellIndex = Math.max(originalCellIndex, diff.originalCellIndex ?? originalCellIndex);
			continue;
		}
		if (i === indexOfEntry) {
			const edit: ICellReplaceEdit = { cells: [cellToInsert], count: 0, editType: CellEditType.Replace, index: originalCellIndex + 1 };
			applyEdits([edit], true, undefined, () => undefined, undefined, true);
			cellDiffInfo[i] = createModifiedCellDiffInfo(modifiedCellIndex, originalCellIndex + 1);
			continue;
		} else {
			// Increase the original index for all entries after this.
			if (typeof diff.originalCellIndex === 'number') {
				diff.originalCellIndex++;
				cellDiffInfo[i] = { ...diff };
			}
		}
	}
	return cellDiffInfo;
}

export function adjustCellDiffAndOriginalModelBasedOnCellAddDelete(change: NotebookCellTextModelSplice<ICell>,
	cellDiffInfo: ICellDiffInfo[],
	modifiedModelCellCount: number,
	originalModelCellCount: number,
	applyEdits: typeof NotebookTextModel.prototype.applyEdits,
	createModifiedCellDiffInfo: (modifiedCellIndex: number, originalCellIndex: number) => ICellDiffInfo,
): ICellDiffInfo[] {
	cellDiffInfo = sortCellChanges(cellDiffInfo);
	const numberOfCellsInserted = change[2].length;
	const numberOfCellsDeleted = change[1];
	const cells = change[2].map(cell => {
		return {
			cellKind: cell.cellKind,
			language: cell.language,
			metadata: cell.metadata,
			outputs: cell.outputs,
			source: cell.getValue(),
			mime: undefined,
			internalMetadata: cell.internalMetadata
		} satisfies ICellDto2;
	});
	const wasInsertedAsFirstCell = change[0] === 0;
	const wasInsertedAsLastCell = change[0] === modifiedModelCellCount - 1;
	const diffEntryIndex = wasInsertedAsFirstCell ? 0 : (wasInsertedAsLastCell ? cellDiffInfo.length - 1 : (cellDiffInfo.findIndex(d => d.modifiedCellIndex === change[0])));
	const indexToInsertInOriginalModel = (wasInsertedAsFirstCell || diffEntryIndex === -1) ? 0 : (wasInsertedAsLastCell ? originalModelCellCount : (((cellDiffInfo.slice(0, diffEntryIndex).reverse().find(c => typeof c.originalCellIndex === 'number')?.originalCellIndex ?? -1) + 1)));
	if (cells.length) {
		const edit: ICellEditOperation = {
			editType: CellEditType.Replace,
			cells,
			index: indexToInsertInOriginalModel,
			count: change[1]
		};
		applyEdits([edit], true, undefined, () => undefined, undefined, true);
	}
	// If cells were deleted we handled that with this.disposeDeletedCellEntries();
	if (numberOfCellsDeleted) {
		// Adjust the indexes.
		let numberOfOriginalCellsRemovedSoFar = 0;
		let numberOfModifiedCellsRemovedSoFar = 0;
		const modifiedIndexesToRemove = new Set<number>();
		for (let i = 0; i < numberOfCellsDeleted; i++) {
			modifiedIndexesToRemove.add(change[0] + i);
		}
		const itemsToRemove = new Set<ICellDiffInfo>();
		for (let i = 0; i < cellDiffInfo.length; i++) {
			const diff = cellDiffInfo[i];
			if (i < diffEntryIndex) {
				continue;
			}

			let changed = false;
			if (typeof diff.modifiedCellIndex === 'number' && modifiedIndexesToRemove.has(diff.modifiedCellIndex)) {
				// This will be removed.
				numberOfModifiedCellsRemovedSoFar++;
				if (typeof diff.originalCellIndex === 'number') {
					numberOfOriginalCellsRemovedSoFar++;
				}
				itemsToRemove.add(diff);
				continue;
			}
			if (typeof diff.modifiedCellIndex === 'number' && numberOfModifiedCellsRemovedSoFar) {
				diff.modifiedCellIndex -= numberOfModifiedCellsRemovedSoFar;
				changed = true;
			}
			if (typeof diff.originalCellIndex === 'number' && numberOfOriginalCellsRemovedSoFar) {
				diff.originalCellIndex -= numberOfOriginalCellsRemovedSoFar;
				changed = true;
			}
			if (changed) {
				cellDiffInfo[i] = { ...diff };
			}
		}
		if (itemsToRemove.size) {
			Array.from(itemsToRemove)
				.filter(diff => typeof diff.originalCellIndex === 'number')
				.forEach(diff => {
					const edit: ICellEditOperation = {
						editType: CellEditType.Replace,
						cells: [],
						index: diff.originalCellIndex,
						count: 1
					};
					applyEdits([edit], true, undefined, () => undefined, undefined, true);
				});
		}
		cellDiffInfo = cellDiffInfo.filter(d => !itemsToRemove.has(d));
	}

	if (numberOfCellsInserted) {
		for (let i = 0; i < cellDiffInfo.length; i++) {
			const diff = cellDiffInfo[i];
			if (i < diffEntryIndex) {
				continue;
			}
			let changed = false;
			if (typeof diff.modifiedCellIndex === 'number') {
				diff.modifiedCellIndex += numberOfCellsInserted;
				changed = true;
			}
			if (typeof diff.originalCellIndex === 'number') {
				diff.originalCellIndex += numberOfCellsInserted;
				changed = true;
			}
			if (changed) {
				cellDiffInfo[i] = { ...diff };
			}
		}
	}

	// For inserted cells, we need to ensure that we create a corresponding CellEntry.
	// So that any edits to the inserted cell is handled and mirrored over to the corresponding cell in original model.
	cells.forEach((_, i) => {
		const originalCellIndex = i + indexToInsertInOriginalModel;
		const modifiedCellIndex = change[0] + i;
		const unchangedCell = createModifiedCellDiffInfo(modifiedCellIndex, originalCellIndex);
		cellDiffInfo.splice((diffEntryIndex === -1 ? 0 : diffEntryIndex) + i, 0, unchangedCell);
	});
	return cellDiffInfo;
}

/**
 * Given the movements of cells in modified notebook, adjust the ICellDiffInfo[] array
 * and generate edits for the old notebook (if required).
 * TODO@DonJayamanne Handle bulk moves (movements of more than 1 cell).
 */
export function adjustCellDiffAndOriginalModelBasedOnCellMovements(event: NotebookCellsModelMoveEvent<ICell>, cellDiffInfo: ICellDiffInfo[]): [ICellDiffInfo[], ICellEditOperation[]] | undefined {
	const minimumIndex = Math.min(event.index, event.newIdx);
	const maximumIndex = Math.max(event.index, event.newIdx);
	const cellDiffs = cellDiffInfo.slice();
	const indexOfEntry = cellDiffs.findIndex(d => d.modifiedCellIndex === event.index);
	const indexOfEntryToPlaceBelow = cellDiffs.findIndex(d => d.modifiedCellIndex === event.newIdx);
	if (indexOfEntry === -1 || indexOfEntryToPlaceBelow === -1) {
		return undefined;
	}
	// Create a new object so that the observable value is triggered.
	// Besides we'll be updating the values of this object in place.
	const entryToBeMoved = { ...cellDiffs[indexOfEntry] };
	const moveDirection = event.newIdx > event.index ? 'down' : 'up';


	const startIndex = cellDiffs.findIndex(d => d.modifiedCellIndex === minimumIndex);
	const endIndex = cellDiffs.findIndex(d => d.modifiedCellIndex === maximumIndex);
	const movingExistingCell = typeof entryToBeMoved.originalCellIndex === 'number';
	let originalCellsWereEffected = false;
	for (let i = 0; i < cellDiffs.length; i++) {
		const diff = cellDiffs[i];
		let changed = false;
		if (moveDirection === 'down') {
			if (i > startIndex && i <= endIndex) {
				if (typeof diff.modifiedCellIndex === 'number') {
					changed = true;
					diff.modifiedCellIndex = diff.modifiedCellIndex - 1;
				}
				if (typeof diff.originalCellIndex === 'number' && movingExistingCell) {
					diff.originalCellIndex = diff.originalCellIndex - 1;
					originalCellsWereEffected = true;
					changed = true;
				}
			}
		} else {
			if (i >= startIndex && i < endIndex) {
				if (typeof diff.modifiedCellIndex === 'number') {
					changed = true;
					diff.modifiedCellIndex = diff.modifiedCellIndex + 1;
				}
				if (typeof diff.originalCellIndex === 'number' && movingExistingCell) {
					diff.originalCellIndex = diff.originalCellIndex + 1;
					originalCellsWereEffected = true;
					changed = true;
				}
			}
		}
		// Create a new object so that the observable value is triggered.
		// Do only if there's a change.
		if (changed) {
			cellDiffs[i] = { ...diff };
		}
	}
	entryToBeMoved.modifiedCellIndex = event.newIdx;
	const originalCellIndex = entryToBeMoved.originalCellIndex;
	if (moveDirection === 'down') {
		cellDiffs.splice(endIndex + 1, 0, entryToBeMoved);
		cellDiffs.splice(startIndex, 1);
		// If we're moving a new cell up/down, then we need just adjust just the modified indexes of the cells in between.
		// If we're moving an existing up/down, then we need to adjust the original indexes as well.
		if (typeof entryToBeMoved.originalCellIndex === 'number') {
			entryToBeMoved.originalCellIndex = cellDiffs.slice(0, endIndex).reduce((lastOriginalIndex, diff) => typeof diff.originalCellIndex === 'number' ? Math.max(lastOriginalIndex, diff.originalCellIndex) : lastOriginalIndex, -1) + 1;
		}
	} else {
		cellDiffs.splice(endIndex, 1);
		cellDiffs.splice(startIndex, 0, entryToBeMoved);
		// If we're moving a new cell up/down, then we need just adjust just the modified indexes of the cells in between.
		// If we're moving an existing up/down, then we need to adjust the original indexes as well.
		if (typeof entryToBeMoved.originalCellIndex === 'number') {
			entryToBeMoved.originalCellIndex = cellDiffs.slice(0, startIndex).reduce((lastOriginalIndex, diff) => typeof diff.originalCellIndex === 'number' ? Math.max(lastOriginalIndex, diff.originalCellIndex) : lastOriginalIndex, -1) + 1;
		}
	}

	// If this is a new cell that we're moving, and there are no existing cells in between, then we can just move the new cell.
	// I.e. no need to update the original notebook model.
	if (typeof entryToBeMoved.originalCellIndex === 'number' && originalCellsWereEffected && typeof originalCellIndex === 'number' && entryToBeMoved.originalCellIndex !== originalCellIndex) {
		const edit: ICellEditOperation = {
			editType: CellEditType.Move,
			index: originalCellIndex,
			length: event.length,
			newIdx: entryToBeMoved.originalCellIndex
		};

		return [cellDiffs, [edit]];
	}

	return [cellDiffs, []];
}
