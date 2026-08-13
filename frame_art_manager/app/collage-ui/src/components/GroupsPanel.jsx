import { useEffect, useMemo, useState } from 'react';
import {
  buildGroup,
  createGroup,
  deleteGroup,
  fetchGroups,
  updateGroup,
} from '../api.js';
import { MULTI_TEMPLATES, TEMPLATES, defaultMatte, matteForUi } from '../geometry.js';
import MattePanel from './MattePanel.jsx';

const MODES = [
  { key: 'coverage', label: 'Coverage', hint: 'one run covers every photo in the tags' },
  { key: 'fluid', label: 'Fluid', hint: 'rotates a few at a time (not built yet)' },
];

const SKIP_REASON_LABELS = {
  'unknown-aspect': 'no image dimensions on record',
  'no-fitting-window': 'no template window fits it',
  'no-fillable-template': 'nothing compatible to pair it with',
  'landscape-solo': 'set aside by the landscape-solo split',
};

const INPUT =
  'w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-400 focus:outline-none';

function Chip({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors cursor-pointer ${
        selected
          ? 'border-sky-400 bg-sky-400/15 text-sky-200'
          : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
      }`}
    >
      {children}
    </button>
  );
}

/** The suggested output tag for a group name, per #7 decision 7. */
function suggestedOutputTag(name) {
  return name.trim() ? `${name.trim()}-collage` : '';
}

function blankDraft() {
  return {
    name: '',
    sourceTags: [],
    outputTag: '',
    matte: defaultMatte(),
    templatePool: MULTI_TEMPLATES,
    landscapeSolo: false,
    mode: 'coverage',
  };
}

function draftFromGroup(group) {
  return {
    name: group.name,
    sourceTags: group.sourceTags,
    outputTag: group.outputTag,
    matte: matteForUi(group.matteSpec),
    templatePool: group.templatePool,
    landscapeSolo: group.landscapeSolo,
    mode: group.mode,
  };
}

/** What the API stores — the draft's matte is a sparse spec the server resolves. */
function groupFromDraft(draft) {
  return {
    name: draft.name.trim(),
    sourceTags: draft.sourceTags,
    outputTag: draft.outputTag.trim() || suggestedOutputTag(draft.name),
    matteSpec: draft.matte,
    templatePool: draft.templatePool,
    landscapeSolo: draft.landscapeSolo,
    mode: draft.mode,
  };
}

/** Why each photo missed the batch — never a bare count. */
function SkipList({ skipped }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {skipped.map((skip) => (
        <li key={skip.imageId} className="text-neutral-500">
          <span className="font-mono text-neutral-400">{skip.imageId}</span> —{' '}
          {SKIP_REASON_LABELS[skip.reason] || skip.reason}
        </li>
      ))}
    </ul>
  );
}

function LastRun({ run }) {
  const [showSkips, setShowSkips] = useState(false);
  if (!run) {
    return <p className="text-xs text-neutral-500">No run since the server started.</p>;
  }

  return (
    <div className="text-xs text-neutral-400">
      <p>
        Last run {new Date(run.finishedAt).toLocaleString()}:{' '}
        <span className="text-neutral-200">{run.created.length} collages</span>
        {run.removed.length > 0 && <> · replaced {run.removed.length}</>}
        {run.skipped.length > 0 && (
          <>
            {' '}
            ·{' '}
            <button
              type="button"
              onClick={() => setShowSkips((open) => !open)}
              className="text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              {run.skipped.length} skipped {showSkips ? '▾' : '▸'}
            </button>
          </>
        )}
      </p>
      {showSkips && <SkipList skipped={run.skipped} />}
    </div>
  );
}

function GroupCard({ group, busy, onRun, onEdit, onDelete }) {
  return (
    <li className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h3 className="text-base font-medium text-neutral-100">{group.name}</h3>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
          {group.mode}
        </span>
        <span className="text-xs text-neutral-500">
          {group.sourceTags.join(', ')} → <span className="text-neutral-300">{group.outputTag}</span>
        </span>
      </div>

      <p className="text-xs text-neutral-500">
        {group.templatePool.map((key) => TEMPLATES[key]?.label || key).join(' · ')}
        {group.landscapeSolo && ' · landscapes as solos'}
        {' · '}
        {group.matteSpec.swatch} matte, {group.matteSpec.borderWidth}px border
      </p>

      <LastRun run={group.lastRun} />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRun}
          disabled={busy || group.mode !== 'coverage'}
          title={group.mode === 'coverage' ? undefined : 'Only coverage groups can be built'}
          className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? 'Building…' : 'Run now'}
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="rounded-lg border border-neutral-600 px-4 py-1.5 text-xs text-neutral-300 hover:border-neutral-400 disabled:opacity-40 cursor-pointer"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded-lg border border-neutral-700 px-4 py-1.5 text-xs text-neutral-500 hover:border-red-500 hover:text-red-400 disabled:opacity-40 cursor-pointer"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function GroupForm({ draft, setDraft, allTags, editing, saving, error, onSave, onCancel }) {
  const set = (patch) => setDraft((cur) => ({ ...cur, ...patch }));

  const toggleIn = (list, value) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  // The output tag follows the name until the user types their own.
  const setName = (name) =>
    setDraft((cur) => ({
      ...cur,
      name,
      outputTag:
        cur.outputTag === suggestedOutputTag(cur.name) ? suggestedOutputTag(name) : cur.outputTag,
    }));

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5 space-y-5">
      <h3 className="text-base font-medium text-neutral-100">
        {editing ? `Edit “${editing}”` : 'New collage group'}
      </h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="group-name" className="block text-sm font-medium text-neutral-300 mb-1">
            Name
          </label>
          <input
            id="group-name"
            type="text"
            value={draft.name}
            disabled={Boolean(editing)}
            onChange={(e) => setName(e.target.value)}
            placeholder="hawaii"
            className={`${INPUT} disabled:opacity-50`}
          />
          {editing && (
            <p className="mt-1 text-xs text-neutral-500">
              Groups can’t be renamed — the name is stamped on every collage they build.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="group-output-tag" className="block text-sm font-medium text-neutral-300 mb-1">
            Output tag
          </label>
          <input
            id="group-output-tag"
            type="text"
            value={draft.outputTag}
            onChange={(e) => set({ outputTag: e.target.value })}
            placeholder={suggestedOutputTag(draft.name) || 'hawaii-collage'}
            className={INPUT}
          />
          <p className="mt-1 text-xs text-neutral-500">
            The only tag the outputs carry — nothing is inherited from the photos.
          </p>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-medium text-neutral-300 mb-2">Source tags</h4>
        <div className="flex flex-wrap gap-2">
          {allTags.map((tag) => (
            <Chip
              key={tag}
              selected={draft.sourceTags.includes(tag)}
              onClick={() => set({ sourceTags: toggleIn(draft.sourceTags, tag) })}
            >
              {tag}
            </Chip>
          ))}
          {allTags.length === 0 && (
            <p className="text-xs text-neutral-500">No tags in the library yet.</p>
          )}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-medium text-neutral-300 mb-2">Templates</h4>
        <div className="flex flex-wrap gap-2">
          {Object.entries(TEMPLATES).map(([key, template]) => (
            <Chip
              key={key}
              selected={draft.templatePool.includes(key)}
              onClick={() => set({ templatePool: toggleIn(draft.templatePool, key) })}
            >
              {template.label}
            </Chip>
          ))}
        </div>
        <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draft.landscapeSolo}
            onChange={(e) => set({ landscapeSolo: e.target.checked })}
            className="mt-0.5 accent-sky-400 cursor-pointer"
          />
          <span className="text-xs text-neutral-300">
            Landscapes as solos
            <span className="block text-neutral-500">
              keeps landscapes out of multi-photo templates and mattes them 1-up
            </span>
          </span>
        </label>
      </div>

      <div>
        <h4 className="text-sm font-medium text-neutral-300 mb-2">Mode</h4>
        <div className="flex flex-wrap gap-2">
          {MODES.map(({ key, label, hint }) => (
            <Chip key={key} selected={draft.mode === key} onClick={() => set({ mode: key })}>
              {label} <span className="text-neutral-500">· {hint}</span>
            </Chip>
          ))}
        </div>
      </div>

      <MattePanel matte={draft.matte} onChange={(matte) => set({ matte })} />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create group'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-lg border border-neutral-600 px-5 py-2 text-sm text-neutral-300 hover:border-neutral-400 disabled:opacity-40 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Collage groups (#11): the standing configs that build a whole batch at
 * once. Create/edit reuses the builder's matte controls, so a group is matted
 * exactly the way a hand-made collage is; "Run now" fires a coverage build and
 * reports what it made and what it could not place.
 */
export default function GroupsPanel({ allTags }) {
  const [groups, setGroups] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busyGroup, setBusyGroup] = useState(null);
  const [notice, setNotice] = useState(null);

  const reload = () =>
    fetchGroups()
      .then(setGroups)
      .catch((err) => setLoadError(err.message));

  useEffect(() => {
    reload();
  }, []);

  const sorted = useMemo(
    () => (groups || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [groups]
  );

  const startCreate = () => {
    setEditing(null);
    setFormError(null);
    setDraft(blankDraft());
  };

  const startEdit = (group) => {
    setEditing(group.name);
    setFormError(null);
    setDraft(draftFromGroup(group));
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const payload = groupFromDraft(draft);
      if (editing) {
        await updateGroup(editing, payload);
      } else {
        await createGroup(payload);
      }
      setDraft(null);
      setEditing(null);
      await reload();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const run = async (group) => {
    setBusyGroup(group.name);
    setNotice(null);
    try {
      const summary = await buildGroup(group.name);
      setNotice({
        tone: 'ok',
        text:
          `${group.name}: built ${summary.created.length} collages` +
          (summary.removed.length ? `, replaced ${summary.removed.length}` : '') +
          (summary.skipped.length ? `, skipped ${summary.skipped.length}` : ''),
      });
      await reload();
    } catch (err) {
      // A refused build still reports why every photo missed out — the group
      // card has no run to show it, so surface it here.
      setNotice({ tone: 'error', text: `${group.name}: ${err.message}`, skipped: err.skipped });
    } finally {
      setBusyGroup(null);
    }
  };

  const remove = async (group) => {
    if (!window.confirm(`Delete the group “${group.name}”? Its collages stay in the library.`)) {
      return;
    }
    setBusyGroup(group.name);
    setNotice(null);
    try {
      const { keptCollages } = await deleteGroup(group.name);
      setNotice({
        tone: 'ok',
        text: `${group.name} deleted — ${keptCollages} collages left in the library.`,
      });
      if (editing === group.name) {
        setDraft(null);
        setEditing(null);
      }
      await reload();
    } catch (err) {
      setNotice({ tone: 'error', text: `${group.name}: ${err.message}` });
    } finally {
      setBusyGroup(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-medium text-neutral-100">Collage groups</h2>
        <p className="text-sm text-neutral-500">
          Standing batches: photos in, matted collages out, replaced on every run.
        </p>
      </div>

      {loadError && <p className="text-red-400">Could not load groups: {loadError}</p>}
      {!groups && !loadError && <p className="text-neutral-500">Loading groups…</p>}

      {notice && (
        <div className="text-xs">
          <p className={`text-sm ${notice.tone === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
            {notice.text}
          </p>
          {notice.skipped && notice.skipped.length > 0 && <SkipList skipped={notice.skipped} />}
        </div>
      )}

      {groups && (
        <ul className="space-y-3">
          {sorted.map((group) => (
            <GroupCard
              key={group.name}
              group={group}
              busy={busyGroup === group.name}
              onRun={() => run(group)}
              onEdit={() => startEdit(group)}
              onDelete={() => remove(group)}
            />
          ))}
          {sorted.length === 0 && (
            <li className="text-sm text-neutral-500">No groups yet.</li>
          )}
        </ul>
      )}

      {draft ? (
        <GroupForm
          draft={draft}
          setDraft={setDraft}
          allTags={allTags}
          editing={editing}
          saving={saving}
          error={formError}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setEditing(null);
          }}
        />
      ) : (
        groups && (
          <button
            type="button"
            onClick={startCreate}
            className="rounded-lg border border-neutral-600 px-5 py-2 text-sm text-neutral-200 hover:border-neutral-400 cursor-pointer"
          >
            + New group
          </button>
        )
      )}
    </div>
  );
}
