/**
 * What the person is working on right now — the object open on the page (a dataset, a dashboard, a notebook, a
 * query tab, an app). The top bar shows it after the section, and DuckView AI receives it as context, so nobody has
 * to name the table or dashboard they are looking at.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

export type PageObjectKind = 'dataset' | 'dashboard' | 'notebook' | 'query' | 'app' | 'model' | 'agent' | 'workspace';
export interface PageObject {
  kind: PageObjectKind;
  id?: string;
  label: string;
}

export const usePageContext = create<{ object: PageObject | null; set(o: PageObject | null): void }>((set) => ({
  object: null,
  set: (object) => set({ object }),
}));

/** Declares the object this page shows; cleared when the page goes away. */
export function usePageObject(o: PageObject | null) {
  const key = o ? `${o.kind}:${o.id ?? ''}:${o.label}` : '';
  useEffect(() => {
    usePageContext.getState().set(o);
    return () => {
      if (usePageContext.getState().object && `${usePageContext.getState().object!.kind}:${usePageContext.getState().object!.id ?? ''}:${usePageContext.getState().object!.label}` === key) usePageContext.getState().set(null);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
