import type { NapiResolveOptions } from 'unrs-resolver';
import type { NewResolver } from './types.js';
export type NodeResolver = NewResolver & {
    clearCache: () => void;
};
export declare function createNodeResolver({ extensions, conditionNames, mainFields, ...restOptions }?: NapiResolveOptions): NodeResolver;
