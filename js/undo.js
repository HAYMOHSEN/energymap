// EnergyMap — "Undo" buttons in toasts undo exactly the change they announce.
import { lastCommitId, undoIf } from './state.js';
import { toast } from './ui.js';

/** Call right after an action; returns a handler that undoes that action only. */
export function undoFn() {
  const id = lastCommitId();
  return () => {
    if (!undoIf(id)) toast('Other changes were made after this one — press Ctrl+Z to step back through them.', { iconName: 'info', timeout: 4500 });
  };
}
