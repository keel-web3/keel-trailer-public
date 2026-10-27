import type { PlayerStats } from './runtime-types.js';
export interface BrowserTestReport extends Record<string, unknown> {
    schema: string;
    checks: Record<string, boolean>;
    errors: string[];
    publication: string;
    controlInput?: {
        isTrusted: boolean;
        target: string;
    } | null;
    saveControl?: {
        isTrusted: boolean;
        target: string;
    } | null;
    performance?: PlayerStats;
    pass?: boolean;
    reportPath?: string;
    bundleSha256?: string;
    lastState?: unknown;
    media?: unknown;
    video?: unknown;
    requests?: string[];
}
