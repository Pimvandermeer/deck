import { useMemo } from "react";
import type { BoardIssue } from "../../../main/board/types.js";
import { Icon } from "./icons.js";

// Filtering runs on the normalised card, never on a tracker's own shape, so
// the same bar serves Jira, Linear and GitHub. A facet whose field no tracker
// filled in has nothing to offer and never renders.

const FACETS = [{ field: "type", label: "Type" }] as const;

type FacetField = (typeof FACETS)[number]["field"];

export interface BoardFilters {
  text: string;
  mineOnly: boolean;
  yourMove: boolean;
  facets: Partial<Record<FacetField, string>>;
}

export const noBoardFilters: BoardFilters = { text: "", mineOnly: false, yourMove: false, facets: {} };

export function boardFiltersActive(filters: BoardFilters): boolean {
  return Boolean(filters.text || filters.mineOnly || filters.yourMove || Object.values(filters.facets).some(Boolean));
}

/** `yourMoveKeys` stays undefined until the PR activity is in, so the filter
 *  waits rather than emptying the board. */
export function filterBoardIssues(
  issues: BoardIssue[],
  filters: BoardFilters,
  myAccountId?: string,
  yourMoveKeys?: Set<string>,
): BoardIssue[] {
  const text = filters.text.trim().toLowerCase();
  return issues.filter((issue) => {
    if (filters.mineOnly && myAccountId && issue.assigneeId !== myAccountId) return false;
    if (filters.yourMove && yourMoveKeys && !yourMoveKeys.has(issue.key)) return false;
    for (const { field } of FACETS) {
      const wanted = filters.facets[field];
      if (wanted && issue[field] !== wanted) return false;
    }
    if (!text) return true;
    return `${issue.key} ${issue.summary} ${issue.assignee ?? ""}`.toLowerCase().includes(text);
  });
}

const chip = "h-[30px] rounded-lg border border-edge bg-panel text-[12px] outline-none";
const toggle = (on: boolean) => `${chip} inline-flex items-center gap-1.5 px-3 ${on ? "border-edge3 bg-card2 text-ink" : "text-body hover:text-ink"}`;

export function BoardFilterBar({ issues, filters, onChange, canFilterMine, shown, yourMove }: {
  /** Every card on the board: the options stay put as the filters narrow it. */
  issues: BoardIssue[];
  filters: BoardFilters;
  onChange: (patch: Partial<BoardFilters>) => void;
  canFilterMine: boolean;
  shown: number;
  /** Cards that are the user's move; undefined while that is not known yet. */
  yourMove?: number;
}) {
  const facets = useMemo(
    () =>
      FACETS.map((facet) => ({
        ...facet,
        values: [...new Set(issues.map((issue) => issue[facet.field]).filter(Boolean))].sort() as string[],
      })).filter((facet) => facet.values.length > 1),
    [issues],
  );

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-6 py-2.5">
      <label className={`${chip} flex w-60 items-center gap-2 px-2.5 text-mut focus-within:border-edge3`}>
        <Icon name="search" size={13} />
        <input
          value={filters.text}
          onChange={(event) => onChange({ text: event.target.value })}
          placeholder="Filter cards"
          aria-label="Filter cards"
          className="min-w-0 flex-1 bg-transparent text-soft outline-none placeholder:text-mut"
        />
      </label>
      {facets.map((facet) => {
        const value = filters.facets[facet.field] ?? "";
        return (
          <label key={facet.field} className={`${chip} inline-flex items-center gap-2 pl-2.5 pr-1 text-mut focus-within:border-edge3 ${value ? "border-edge3" : ""}`}>
            {facet.label}
            <select
              value={value}
              aria-label={facet.label}
              onChange={(event) => onChange({ facets: { ...filters.facets, [facet.field]: event.target.value } })}
              className={`h-[26px] bg-panel outline-none ${value ? "text-ink" : "text-soft"}`}
            >
              <option value="">All</option>
              {facet.values.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        );
      })}
      {canFilterMine && (
        <button
          onClick={() => onChange({ mineOnly: !filters.mineOnly })}
          aria-pressed={filters.mineOnly}
          title="Show only issues assigned to me"
          className={toggle(filters.mineOnly)}
        >
          My tasks
        </button>
      )}
      {/* Kept while on, even at zero, so the filter can still be turned off. */}
      {yourMove !== undefined && (yourMove > 0 || filters.yourMove) && (
        <button
          onClick={() => onChange({ yourMove: !filters.yourMove })}
          aria-pressed={filters.yourMove}
          title="Show only cards that are your move"
          className={toggle(filters.yourMove)}
        >
          <span className="h-[7px] w-[7px] rounded-full bg-orange" />
          Your move <span className="font-mono text-mut">{yourMove}</span>
        </button>
      )}
      {boardFiltersActive(filters) && (
        <>
          <button onClick={() => onChange(noBoardFilters)} className="text-[12px] text-mut hover:text-ink">
            Clear
          </button>
          <span className="ml-auto font-mono text-[11px] text-mut">
            {shown} of {issues.length}
          </span>
        </>
      )}
    </div>
  );
}
