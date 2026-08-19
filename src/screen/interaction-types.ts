export type ChoiceInteractionKind = 'approval' | 'question' | 'choice';
export type ChoiceRisk = 'normal' | 'persistent' | 'privileged' | 'reject';
export type ControlRole = 'answer' | 'submit' | 'custom-input' | 'chat';
export type SelectionMarker = 'checked' | 'unchecked' | 'selected' | 'unselected';

export interface SelectionSemantics {
  cardinality: 'one' | 'many';
  activation: 'submit' | 'toggle';
  /** Key used by the TUI to toggle the focused persistent selection. */
  toggleKey?: string;
  commit:
    | { mode: 'immediate' }
    | { mode: 'explicit'; controlId: string }
    | { mode: 'key'; key: string };
  confidence: number;
  evidence: string[];
}

export interface ScreenAction {
  id: string;
  label: string;
  key: string;
  description?: string;
  /** User-provided value shown by a dynamic custom-input control. */
  inputValue?: string;
  shortcut?: string;
  /** Optional editor opened from this control, such as Trae's Other notes field. */
  editor?: {
    /** Omitted when typing directly into the focused control opens the editor. */
    openKey?: string;
    submitKey: string;
    commitsInteraction: boolean;
  };
  /** True only when the terminal cursor is currently focused on this control. */
  focused?: boolean;
  marker?: SelectionMarker;
  role?: ControlRole;
  risk?: ChoiceRisk;
  danger?: boolean;
}

export interface ChoiceInteraction {
  kind: ChoiceInteractionKind;
  title: string;
  context: string[];
  interactionId?: string;
  revision?: string;
  semantics?: SelectionSemantics;
  contentConfidence?: number;
  actionConfidence?: number;
}

export interface TerminalDialect {
  id: 'codex' | 'trae-cli' | 'claude-code';
  headerPatterns: readonly RegExp[];
  footerPatterns: readonly RegExp[];
  footerlessChoiceHeaders?: readonly RegExp[];
  submitControls: readonly RegExp[];
  customInputControls: readonly RegExp[];
  /** Custom controls that become editable as soon as the user starts typing. */
  directInputControls?: readonly RegExp[];
  customInputValuePattern?: RegExp;
  chatControls: readonly RegExp[];
}
