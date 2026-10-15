import { createContext, useContext } from 'react';
import { DEFAULT_LAYOUT_DIRECTION, type LayoutDirection } from './layout';

export const LayoutDirectionContext = createContext<LayoutDirection>(DEFAULT_LAYOUT_DIRECTION);

export function useLayoutDirection(): LayoutDirection {
    return useContext(LayoutDirectionContext);
}
