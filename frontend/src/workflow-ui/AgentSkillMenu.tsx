// The Agent composer's `/skill:` menu: the workspace's skills, from
// `.duckle/skills/<name>/SKILL.md`, offered while the input holds a single
// `/command` token.
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AgentSkill } from '../tauri-bridge';

const PREFIX = 'skill:';

/** The text after `/` while the whole input is one `/token`, else null. */
export function slashQuery(draft: string): string | null {
    const m = /^\/(\S*)$/.exec(draft);
    return m ? m[1] : null;
}

/** Whether `/query` reads as the start of a skill command, so an empty list is
 *  worth explaining rather than hiding. */
export function looksLikeSkillCommand(query: string): boolean {
    const q = query.toLowerCase();
    return PREFIX.startsWith(q) || q.startsWith(PREFIX);
}

/** The skills `/query` matches: all of them while it is still a prefix of
 *  `skill:`, then by name, those starting with the typed name first. */
export function matchSkills(skills: AgentSkill[], query: string): AgentSkill[] {
    const q = query.toLowerCase();
    if (PREFIX.startsWith(q)) return skills;
    const name = q.startsWith(PREFIX) ? q.slice(PREFIX.length) : q;
    if (!name) return skills;
    const starts = skills.filter(s => s.name.toLowerCase().startsWith(name));
    const contains = skills.filter(s => !starts.includes(s) && s.name.toLowerCase().includes(name));
    return [...starts, ...contains];
}

export const skillCommand = (skill: AgentSkill) => `/${PREFIX}${skill.name}`;

export function SkillCommandMenu({
    anchor,
    items,
    total,
    active,
    skillsDir,
    onPick,
    onHover,
}: {
    anchor: HTMLElement | null;
    /** The skills that match what is typed. */
    items: AgentSkill[];
    /** How many skills the workspace has at all. */
    total: number;
    active: number;
    skillsDir: string;
    onPick: (skill: AgentSkill) => void;
    onHover: (index: number) => void;
}) {
    const { t } = useTranslation();
    const listRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        listRef.current
            ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [active, items]);

    // Fixed and portaled like the data-source menu, so a docked, short panel
    // cannot clip it; as wide as the composer, above it when there is room.
    const r = anchor?.getBoundingClientRect();
    const MAX_H = 280;
    const style: React.CSSProperties = r
        ? {
              left: r.left,
              width: r.width,
              ...(r.top > MAX_H + 16 ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
          }
        : { left: 16, bottom: 16 };

    return createPortal(
        <div
            ref={listRef}
            className="agent-skill-menu"
            role="listbox"
            aria-label={t('agent.skills.menuAria')}
            style={{ ...style, maxHeight: MAX_H }}
            // Keep focus (and the caret) in the input.
            onMouseDown={e => e.preventDefault()}
        >
            {items.length === 0 ? (
                <div className="agent-skill-empty">
                    {total === 0 ? t('agent.skills.empty', { path: skillsDir }) : t('agent.skills.noMatch')}
                </div>
            ) : (
                items.map((skill, i) => (
                    <button
                        key={skill.name}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-index={i}
                        className={`agent-skill-item${i === active ? ' agent-skill-item-active' : ''}`}
                        title={skill.description ?? skill.path}
                        onMouseEnter={() => onHover(i)}
                        onClick={() => onPick(skill)}
                    >
                        <span className="agent-skill-command">{skillCommand(skill)}</span>
                        {skill.description ? <span className="agent-skill-desc">{skill.description}</span> : null}
                    </button>
                ))
            )}
        </div>,
        document.body,
    );
}
