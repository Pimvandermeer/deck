import { useEffect, useState } from "react";
import type { AgentLink } from "../../../main/agentLinks.js";

const REFRESH_MS = 15_000;

/** Agents running in this workspace's terminals, refreshed when a session
 *  changes status and every few seconds for branch switches. */
export function useAgentLinks(): AgentLink[] {
  const [links, setLinks] = useState<AgentLink[]>([]);
  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const load = () => void window.deck.agents.links().then((next) => { if (!cancelled) setLinks(next); }, () => {});
    // Hooks fire in bursts while an agent works; one reload per burst is enough.
    const soon = () => { clearTimeout(pending); pending = setTimeout(load, 400); };
    load();
    const timer = setInterval(load, REFRESH_MS);
    const off = window.deck.sessions.onChanged(soon);
    return () => { cancelled = true; clearInterval(timer); clearTimeout(pending); off(); };
  }, []);
  return links;
}
