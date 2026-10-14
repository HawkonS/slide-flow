import * as React from "react";

/** Keep IME composition local; only confirmed text may update filters or navigate. */
export function useSearchInput(value: string, onValueChange: (value: string) => void) {
  const [draft, setDraft] = React.useState(value);
  const composing = React.useRef(false);
  const committed = React.useRef(value);

  React.useEffect(() => {
    committed.current = value;
    if (!composing.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    // Some browsers fire a final change after compositionend with the same text.
    if (next === committed.current) return;
    committed.current = next;
    onValueChange(next);
  };

  return {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.value;
      setDraft(next);
      if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) commit(next);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => {
      composing.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      commit(next);
    },
  };
}
