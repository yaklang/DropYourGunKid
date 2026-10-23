export interface InjectionOptions { prefix?: string; origin?: string; entries?: number }
export function escapeHtml(value: unknown): string;
export function normalizeOptions(options?: InjectionOptions): Required<InjectionOptions>;
export function renderLures(options?: InjectionOptions): string;
export function injectHtml(html: string, options?: InjectionOptions): string;
