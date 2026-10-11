import { createContext, useContext } from 'react';

export const NodeSequenceContext = createContext<Map<string, number>>(new Map());

export function useNodeSequence(nodeId: string): number | undefined {
    return useContext(NodeSequenceContext).get(nodeId);
}
