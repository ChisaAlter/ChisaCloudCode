import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, expect, test, vi } from 'vitest';

import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import type { SidebarSessionSelection } from '@/shared/types';

vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;
const project = { projectId: 'project-1', displayName: 'Workspace', fullPath: '/workspace' };
const props: ComponentProps<typeof SidebarProjectItem> = {
  project,
  selectedProject: project,
  selectedSession: null,
  isExpanded: true,
  isDeleting: false,
  isStarred: false,
  isEditing: false,
  renameDraft: '',
  sessions: [{ id: 's1', summary: 'First conversation', __provider: 'claude' }],
  initialSessionsLoaded: true,
  isLoadingMoreSessions: false,
  currentTime: new Date('2026-08-21T10:00:00.000Z'),
  sessionRenameId: null,
  sessionRenameDraft: '',
  tasksEnabled: false,
  mcpServerStatus: null,
  onRenameDraftChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  activeSessions: new Set<string>(),
  backgroundSessionIds: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  onNewSession: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  selectedSessionIds: null,
  onSetSessionSelection: noop,
  onToggleSessionSelected: noop,
  onCancelSessionSelection: noop,
  onDeleteSelectedSessions: noop,
  t,
};

beforeEach(() => localStorage.clear());

test('the project menu supports keyboard entry, selection, cancel and normal session navigation', () => {
  const navigate = vi.fn();
  function Harness() {
    // Mirror the controller's single project selection so menu entry and cancel
    // exercise the real project header, toolbar and session rows together.
    const [selection, setSelection] = useState<SidebarSessionSelection | null>(null);
    return <SidebarProjectItem {...props} onSessionSelect={navigate}
      selectedSessionIds={selection?.sessionIds ?? null} onSetSessionSelection={setSelection}
      onToggleSessionSelected={(projectId, sessionId) => setSelection({ projectId, sessionIds: new Set([sessionId]) })}
      onCancelSessionSelection={() => setSelection(null)} />;
  }
  render(<Harness />);
  expect(screen.queryByRole('button', { name: 'sessions.select' })).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
  const trigger = screen.getByRole('button', { name: 'projects.options' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const entry = screen.getByRole('menuitem', { name: 'sessions.select' });
  expect(document.activeElement).toBe(entry);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('menu')).toBeNull();

  // The same button works with a pointer/touch-generated click, without hover.
  fireEvent.click(trigger, { detail: 1 });
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.select' }));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('toolbar', { name: 'sessions.select' })).toBeTruthy();
  const row = screen.getByRole('checkbox');
  expect(row.getAttribute('aria-checked')).toBe('false');
  fireEvent.keyDown(row, { key: ' ' });
  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  expect(navigate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'actions.cancel' }));
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: /First conversation/ }));
  expect(navigate).toHaveBeenCalledWith(props.sessions[0], project.projectId);
});

test('selection from a collapsed project opens its list before starting with no rows ticked', () => {
  const order: string[] = [];
  const select = vi.fn((selection: SidebarSessionSelection) => {
    order.push('select');
    expect(selection.projectId).toBe(project.projectId);
    expect([...selection.sessionIds]).toEqual([]);
  });
  const toggle = vi.fn(() => order.push('expand'));
  render(<SidebarProjectItem {...props} isExpanded={false} onToggleProject={toggle} onSetSessionSelection={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'projects.options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.select' }));
  expect(toggle).toHaveBeenCalledWith(project.projectId);
  expect(select).toHaveBeenCalledOnce();
  expect(order).toEqual(['expand', 'select']);
});

test.each(['loading', 'empty', 'responding', 'selecting'])(
  '%s project keeps its menu entry disabled without starting a selection', (state) => {
    const select = vi.fn();
    render(<SidebarProjectItem {...props}
      initialSessionsLoaded={state !== 'loading'}
      sessions={state === 'empty' ? [] : props.sessions}
      activeSessions={new Set(state === 'responding' ? ['s1'] : [])}
      selectedSessionIds={state === 'selecting' ? new Set(['s1']) : null}
      onSetSessionSelection={select} />);
    fireEvent.click(screen.getByRole('button', { name: 'projects.options' }));
    const entry = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'sessions.select' });
    expect(entry.disabled).toBe(true);
    fireEvent.click(entry);
    expect(select).not.toHaveBeenCalled();
  },
);

test('background work alone permits entry and keeps that session selectable', () => {
  const select = vi.fn();
  const busy = new Set(['s1']);
  const view = render(<SidebarProjectItem {...props} activeSessions={busy} backgroundSessionIds={busy}
    onSetSessionSelection={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'projects.options' }));
  const entry = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'sessions.select' });
  expect(entry.disabled).toBe(false);
  fireEvent.click(entry);
  expect(select).toHaveBeenCalledOnce();
  const selection = select.mock.calls[0][0] as SidebarSessionSelection;
  view.rerender(<SidebarProjectItem {...props} activeSessions={busy} backgroundSessionIds={busy}
    selectedSessionIds={selection.sessionIds} />);
  expect(screen.getByRole('checkbox').getAttribute('aria-disabled')).toBeNull();
});
