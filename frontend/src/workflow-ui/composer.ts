// Chat composer behaviour shared by the Duckie and Pi Agent panels: the
// textarea grows with its content up to a cap and then scrolls, and Up/Down
// recall the conversation's earlier inputs like a shell.
import { useCallback, useRef } from 'react';

const COMPOSER_MIN_HEIGHT = 72;
const COMPOSER_MAX_HEIGHT = 240;

export function syncComposerHeight(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    textarea.style.height = '0px';
    const next = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${Math.max(next, COMPOSER_MIN_HEIGHT)}px`;
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

/**
 * Shell-style input recall. `getInputs` returns this conversation's earlier
 * user inputs, oldest first. Call `resetRecall` whenever the text is edited or
 * the conversation changes, so the next Up starts again from the newest input.
 */
export function useInputRecall(
    getInputs: () => string[],
    setDraft: (value: string) => void,
    inputRef: React.RefObject<HTMLTextAreaElement | null>,
) {
    /** How many inputs back the composer shows (null = not recalling). */
    const recallIndexRef = useRef<number | null>(null);
    /** The unsent draft to return to. */
    const recallStashRef = useRef('');
    const getInputsRef = useRef(getInputs);
    getInputsRef.current = getInputs;
    const setDraftRef = useRef(setDraft);
    setDraftRef.current = setDraft;

    const resetRecall = useCallback(() => {
        recallIndexRef.current = null;
    }, []);

    /** Up recalls this conversation's earlier inputs, newest first; Down walks
     *  back towards the draft that was being typed. Up only starts recalling
     *  from the composer's first line so multi-line drafts stay editable; once
     *  recalling, both keys keep navigating until the text is edited. */
    const handleRecallKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (event.nativeEvent.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
        const el = event.currentTarget;
        const current = recallIndexRef.current;
        const inputs = getInputsRef.current();
        let next: number;
        if (event.key === 'ArrowUp') {
            const onFirstLine =
                el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n');
            if (current === null && !onFirstLine) return;
            next = (current ?? 0) + 1;
            if (next > inputs.length) {
                event.preventDefault();
                return;
            }
            if (current === null) recallStashRef.current = el.value;
        } else {
            if (current === null) return;
            next = current - 1;
        }
        event.preventDefault();
        const value = next === 0 ? recallStashRef.current : inputs[inputs.length - next];
        recallIndexRef.current = next === 0 ? null : next;
        setDraftRef.current(value);
        requestAnimationFrame(() => {
            const input = inputRef.current;
            if (!input) return;
            input.setSelectionRange(value.length, value.length);
            syncComposerHeight(input);
        });
    }, [inputRef]);

    return { handleRecallKey, resetRecall };
}
