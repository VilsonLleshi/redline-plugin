import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { diffLines, applyHunk, Hunk } from './diff';

// Any write to disk that didn't come from this VS Code window counts as an agent write.
// known:     last content we trust per file (seen on open, saved by you, or kept/undone here).
// baselines: files with pending agent changes -> the accepted content to diff against.
const known = new Map<string, string>();
const baselines = new Map<string, string>();
const cache = new WeakMap<vscode.TextDocument, { version: number; base: string; baseLines: string[]; hunks: Hunk[] }>(); // freed when the doc closes
const timers = new Map<string, NodeJS.Timeout>();
let typing: NodeJS.Timeout | undefined;
const lensChanged = new vscode.EventEmitter<void>();
const run = promisify(execFile);
let addedDeco: vscode.TextEditorDecorationType;
let removedDeco: vscode.TextEditorDecorationType;
let status: vscode.StatusBarItem;

export function activate(ctx: vscode.ExtensionContext) {
  const ruler = (color: string) => ({ 
    overviewRulerColor: new vscode.ThemeColor(color), 
    overviewRulerLane: vscode.OverviewRulerLane.Left, 
    isWholeLine: true 
  });
  addedDeco = vscode.window.createTextEditorDecorationType({ 
    ...ruler('editorOverviewRuler.addedForeground'), 
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground') 
  });
  removedDeco = vscode.window.createTextEditorDecorationType({ 
    ...ruler('editorOverviewRuler.deletedForeground'), 
    borderStyle: 'solid', borderWidth: '2px 0 0 0', 
    borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground') 
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'redline.review';

  vscode.workspace.textDocuments.forEach(remember);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');

  ctx.subscriptions.push(
    addedDeco, removedDeco, status, watcher, lensChanged,
    watcher.onDidChange(onDisk),
    watcher.onDidCreate(onDisk),
    vscode.workspace.onDidOpenTextDocument(remember),
    vscode.workspace.onDidSaveTextDocument(d => known.set(d.uri.fsPath, d.getText())),
    vscode.workspace.onDidChangeTextDocument(e => baselines.has(e.document.uri.fsPath) && onType()),
    vscode.window.onDidChangeVisibleTextEditors(refresh),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses }),
    vscode.commands.registerCommand('redline.keep', (p: string, h?: Hunk) => resolve(p, 'keep', h)),
    vscode.commands.registerCommand('redline.undo', (p: string, h?: Hunk) => resolve(p, 'undo', h)),
    vscode.commands.registerCommand('redline.keepEverything', () => { baselines.clear(); refresh(); }),
    vscode.commands.registerCommand('redline.review', review),
    // Title-bar buttons pass the editor's uri; from the palette there's none, so use the active editor.
    vscode.commands.registerCommand('redline.keepFile', (u?: vscode.Uri) => withFile(u, p => resolve(p, 'keep'))),
    vscode.commands.registerCommand('redline.undoFile', (u?: vscode.Uri) => withFile(u, p => resolve(p, 'undo'))),
    vscode.commands.registerCommand('redline.nextFile', nextFile),
  );
}

function remember(doc: vscode.TextDocument) {
  if (doc.uri.scheme === 'file' && !doc.isDirty && !known.has(doc.uri.fsPath)) {
    known.set(doc.uri.fsPath, doc.getText());
  }
}

function onDisk(uri: vscode.Uri) {
  // Debounce: agents often write in bursts, and our own save's onDidSave should land first.
  clearTimeout(timers.get(uri.fsPath));
  timers.set(uri.fsPath, setTimeout(() => { timers.delete(uri.fsPath); checkDisk(uri); }, 150));
}

async function checkDisk(uri: vscode.Uri) {
  const p = uri.fsPath;
  // ponytail: every external writer counts as "agent" (git checkout, formatters run from a terminal, ...).
  // Gitignored files are skipped, which covers build output; add an exclude setting if more noise shows up.
  if (p.split(path.sep).includes('.git') || await git(p, 'check-ignore', '-q', p) !== undefined) return;
  let text: string;
  try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return; } // gone or a directory
  if (text.includes('\0') || text === known.get(p)) return; // binary, or our own save
  // Fallback baseline for files we never saw before the agent touched them: the staged version, or empty if new.
  if (!baselines.has(p)) baselines.set(p, known.get(p) ?? await git(p, 'show', `:./${path.basename(p)}`) ?? '');
  if (baselines.get(p) === text) baselines.delete(p); // agent put it back the way it was
  refresh();
}

// stdout of a git command run next to file `p`, or undefined if it fails (not a repo, untracked, not ignored, ...).
async function git(p: string, ...args: string[]): Promise<string | undefined> {
  try { return (await run('git', args, { cwd: path.dirname(p), maxBuffer: 64 << 20 })).stdout; } catch { return undefined; }
}

function hunksFor(doc: vscode.TextDocument): Hunk[] {
  const base = baselines.get(doc.uri.fsPath), hit = cache.get(doc);
  if (base === undefined) return [];
  if (hit?.version === doc.version && hit.base === base) return hit.hunks;
  const baseLines = base.split('\n'), hunks = diffLines(baseLines, doc.getText().split('\n'));
  cache.set(doc, { version: doc.version, base, baseLines, hunks });
  return hunks;
}

// Re-diff once typing pauses, not per keystroke; VS Code shifts existing decorations meanwhile.
function onType() {
  clearTimeout(typing);
  typing = setTimeout(refresh, 100);
}

function refresh() {
  for (const editor of vscode.window.visibleTextEditors) render(editor);
  lensChanged.fire();
  status.text = `$(sparkle) ${baselines.size} agent file${baselines.size === 1 ? '' : 's'}`;
  baselines.size ? status.show() : status.hide();
  // Drive the editor/title button `when` clauses in package.json.
  vscode.commands.executeCommand('setContext', 'redline.files', [...baselines.keys()].map(p => vscode.Uri.file(p).path));
  vscode.commands.executeCommand('setContext', 'redline.count', baselines.size);
}

function render(editor: vscode.TextEditor) {
  const doc = editor.document;
  const hunks = hunksFor(doc), base = cache.get(doc)?.baseLines ?? [];
  const added: vscode.DecorationOptions[] = [], removed: vscode.DecorationOptions[] = [];
  for (const h of hunks) {
    const hoverMessage = h.oldEnd > h.oldStart
      ? new vscode.MarkdownString(h.newEnd > h.newStart ? '**Agent replaced:**' : '**Agent removed:**')
          .appendCodeblock(base.slice(h.oldStart, h.oldEnd).join('\n'), doc.languageId)
      : undefined;
    if (h.newEnd > h.newStart) added.push({ range: new vscode.Range(h.newStart, 0, h.newEnd - 1, 0), hoverMessage });
    else removed.push({ range: lineAt(doc, h.newStart), hoverMessage });
  }
  editor.setDecorations(addedDeco, added);
  editor.setDecorations(removedDeco, removed);
}

const lineAt = (doc: vscode.TextDocument, line: number) => doc.lineAt(Math.min(line, doc.lineCount - 1)).range;

function provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const hunks = hunksFor(doc), p = doc.uri.fsPath;
  const lens = (line: number, title: string, command: string, ...rest: unknown[]) =>
    new vscode.CodeLens(lineAt(doc, line), { title, command, arguments: [p, ...rest] });
  return !hunks.length ? [] : [
    lens(0, `$(check-all) Keep all ${hunks.length} agent changes`, 'redline.keep'),
    lens(0, '$(discard) Undo all', 'redline.undo'),
    ...hunks.flatMap(h => [
      lens(h.newStart, '$(check) Keep', 'redline.keep', h),
      lens(h.newStart, '$(discard) Undo', 'redline.undo', h),
    ]),
  ];
}

// h undefined = whole file.
async function resolve(p: string, action: 'keep' | 'undo', h?: Hunk) {
  const base = baselines.get(p);
  if (base === undefined) return;
  const doc = await vscode.workspace.openTextDocument(p);
  if (h && !hunksFor(doc).some(x => JSON.stringify(x) === JSON.stringify(h))) return refresh(); // stale lens
  const cur = doc.getText();

  if (action === 'keep') {
    baselines.set(p, h ? applyHunk(base.split('\n'), cur.split('\n'), h).join('\n') : cur);
  } else {
    const reverted = h ? applyHunk(cur.split('\n'), base.split('\n'), { oldStart: h.newStart, oldEnd: h.newEnd, newStart: h.oldStart, newEnd: h.oldEnd }).join('\n') : base;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(cur.length)), reverted);
    await vscode.workspace.applyEdit(edit);
    await doc.save(); // so the agent sees the undo on disk too
  }
  if (baselines.get(p) === doc.getText()) { baselines.delete(p); known.set(p, doc.getText()); }
  refresh();
}

function withFile(u: vscode.Uri | undefined, fn: (p: string) => unknown) {
  const p = (u ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
  if (p) fn(p);
}

// Open the pending file after the active one (wrapping around) and scroll to its first change.
async function nextFile() {
  const files = [...baselines.keys()], cur = vscode.window.activeTextEditor?.document.uri.fsPath;
  const next = files[(files.indexOf(cur ?? '') + 1) % files.length];
  if (!next || next === cur) return;
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(next));
  const [first] = hunksFor(editor.document);
  if (first) {
    editor.selection = new vscode.Selection(first.newStart, 0, first.newStart, 0);
    editor.revealRange(lineAt(editor.document, first.newStart), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

async function review() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const pick = await vscode.window.showQuickPick([...baselines.keys()]
    .map(p => ({ label: path.relative(root, p), p })), { placeHolder: 'Files with pending agent changes' });
  if (pick) vscode.window.showTextDocument(vscode.Uri.file(pick.p));
}
