import type { PackageJson } from '../types.js';
export declare function readPkgUp(opts?: {
    cwd?: string;
}): {
    pkg?: undefined;
    path?: undefined;
} | {
    pkg: PackageJson & {
        name: string;
    };
    path: string;
};
