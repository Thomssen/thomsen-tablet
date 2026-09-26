import { useCallback, useEffect, useState } from "react";
import { Page } from "@/components/layout/Page";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { errorMessage, isTauri } from "@/services/ipc";
import {
  defaultFilters,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  getActiveProfileId,
  importProfile,
  listProfiles,
  newProfileId,
  saveProfile,
  setActiveProfile,
} from "@/services/profiles";
import { scanTablets } from "@/services/driver";
import { getPrimaryMonitor } from "@/services/window";
import { openDialog, saveDialog } from "@/services/os";
import type { OsuVariant, Profile } from "@/types";
import "./ProfilesPage.css";

const VARIANT_LABEL: Record<OsuVariant, string> = { stable: "osu! stable", lazer: "osu!lazer" };

export function ProfilesPage() {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<Profile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [toDelete, setToDelete] = useState<Profile | null>(null);
  const [bindingDraft, setBindingDraft] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [list, active] = await Promise.all([listProfiles(), getActiveProfileId()]);
    setProfiles(list);
    setActiveId(active);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createProfile = () =>
    guard(async () => {
      const name = newName.trim();
      if (!name) return;
      const tablets = await scanTablets().catch(() => []);
      const tablet = tablets[0];
      const monitor = await getPrimaryMonitor();
      const tabletArea = tablet
        ? { width: tablet.widthMm, height: tablet.heightMm, x: tablet.widthMm / 2, y: tablet.heightMm / 2, rotation: 0 }
        : { width: 152, height: 95, x: 76, y: 47.5, rotation: 0 };
      const displayArea = monitor
        ? { width: monitor.width, height: monitor.height, x: monitor.x + monitor.width / 2, y: monitor.y + monitor.height / 2, rotation: 0 }
        : { width: 1920, height: 1080, x: 960, y: 540, rotation: 0 };

      const profile: Profile = {
        id: newProfileId(),
        name,
        tabletArea,
        displayArea,
        lockAspectRatio: false,
        inputMode: "absolute",
        relativeSettings: { xSensitivity: 10, ySensitivity: 10 },
        filters: defaultFilters(),
        appBindings: [],
        pressureActivationThreshold: 0,
        osuVariantAssignment: null,
      };
      await saveProfile(profile);
      setCreateOpen(false);
      setNewName("");
      await reload();
      toast.success(`"${name}" created`);
    });

  const doRename = () =>
    guard(async () => {
      if (!renaming) return;
      const name = renameValue.trim();
      if (!name) return;
      await saveProfile({ ...renaming, name });
      setRenaming(null);
      await reload();
      toast.success("Renamed");
    });

  const doDuplicate = (p: Profile) =>
    guard(async () => {
      await duplicateProfile(p.id, `${p.name} copy`);
      await reload();
      toast.success("Duplicated");
    });

  const doDelete = () =>
    guard(async () => {
      if (!toDelete) return;
      await deleteProfile(toDelete.id);
      setToDelete(null);
      await reload();
      toast.success("Deleted");
    });

  const doSetActive = (p: Profile) =>
    guard(async () => {
      await setActiveProfile(p.id);
      setActiveId(p.id);
      toast.success(`"${p.name}" is now active`);
    });

  const doExport = (p: Profile) =>
    guard(async () => {
      const path = await saveDialog({
        title: `Export "${p.name}"`,
        defaultPath: `${p.name}.thomsenprofile`,
        filters: [
          { name: "Thomsen Tablet profile", extensions: ["thomsenprofile"] },
          { name: "JSON", extensions: ["json"] },
        ],
      });
      if (!path) return;
      await exportProfile(p.id, path);
      toast.success("Exported - safe to send to someone else, it contains no personal information");
    });

  const doImport = () =>
    guard(async () => {
      const path = await openDialog({
        title: "Import a Thomsen Tablet profile",
        filters: [
          { name: "Thomsen Tablet profile", extensions: ["thomsenprofile"] },
          { name: "JSON", extensions: ["json"] },
        ],
      });
      if (!path) return;
      const imported = await importProfile(path);
      await reload();
      toast.success(`"${imported.name}" imported`);
    });

  const setOsuVariantAssignment = (p: Profile, variant: OsuVariant | null) =>
    guard(async () => {
      await saveProfile({ ...p, osuVariantAssignment: variant });
      await reload();
      toast.success(variant ? `"${p.name}" assigned to ${VARIANT_LABEL[variant]}` : `"${p.name}" unassigned from osu!`);
    });

  const addBinding = (p: Profile) =>
    guard(async () => {
      const exe = (bindingDraft[p.id] ?? "").trim();
      if (!exe) return;
      const next = { ...p, appBindings: [...p.appBindings, exe] };
      await saveProfile(next);
      setBindingDraft((d) => ({ ...d, [p.id]: "" }));
      await reload();
    });

  const removeBinding = (p: Profile, exe: string) =>
    guard(async () => {
      await saveProfile({ ...p, appBindings: p.appBindings.filter((b) => b !== exe) });
      await reload();
    });

  const loading = profiles === null;

  return (
    <Page
      title="Profiles"
      eyebrow="Setups"
      description="Bundle a tablet area, monitor mapping, input mode and filters together, and switch between them - by hand, automatically per application, or automatically when osu! is running (assign a profile to osu! stable and/or osu!lazer below, then enable auto-switching in Settings → osu!)."
      actions={
        <>
          {isTauri() && (
            <Button size="sm" variant="secondary" onClick={() => void doImport()} disabled={busy}>
              Import…
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} disabled={busy}>
            New Profile
          </Button>
        </>
      }
    >
      <div className="stack">
        {loading ? null : profiles.length === 0 ? (
          <Card>
            <EmptyState
              title="No profiles yet"
              description="Create one for osu!, drawing, or your desktop - each remembers its own tablet area, monitor mapping, input mode and filters."
              action={
                <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                  New Profile
                </Button>
              }
            />
          </Card>
        ) : (
          profiles.map((p) => (
            <Card key={p.id}>
              <CardHeader
                title={
                  <span className="profiles__title">
                    {p.name}
                    {p.id === activeId && <Badge tone="good">Active</Badge>}
                    <Badge tone="neutral">{p.inputMode === "absolute" ? "Absolute" : "Relative"}</Badge>
                    {p.osuVariantAssignment && <Badge tone="good">{VARIANT_LABEL[p.osuVariantAssignment]} profile</Badge>}
                  </span>
                }
                actions={
                  <>
                    {p.id !== activeId && (
                      <Button size="sm" variant="secondary" onClick={() => void doSetActive(p)} disabled={busy}>
                        Set Active
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={p.osuVariantAssignment === "stable" ? "secondary" : "ghost"}
                      onClick={() => void setOsuVariantAssignment(p, p.osuVariantAssignment === "stable" ? null : "stable")}
                      disabled={busy}
                    >
                      Assign osu! stable
                    </Button>
                    <Button
                      size="sm"
                      variant={p.osuVariantAssignment === "lazer" ? "secondary" : "ghost"}
                      onClick={() => void setOsuVariantAssignment(p, p.osuVariantAssignment === "lazer" ? null : "lazer")}
                      disabled={busy}
                    >
                      Assign osu!lazer
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setRenaming(p); setRenameValue(p.name); }} disabled={busy}>
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void doDuplicate(p)} disabled={busy}>
                      Duplicate
                    </Button>
                    {isTauri() && (
                      <Button size="sm" variant="ghost" onClick={() => void doExport(p)} disabled={busy}>
                        Export
                      </Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => setToDelete(p)} disabled={busy}>
                      Delete
                    </Button>
                  </>
                }
              />
              <div className="profiles__meta">
                <span>
                  Tablet area {p.tabletArea.width.toFixed(1)}×{p.tabletArea.height.toFixed(1)}mm
                </span>
                <span>
                  Display {p.displayArea.width.toFixed(0)}×{p.displayArea.height.toFixed(0)}px
                </span>
                {p.lockAspectRatio && <span>Aspect locked</span>}
              </div>

              <Field label="Auto-switch for these applications" hint="Executable file names, e.g. osu!.exe - exact match, case-insensitive.">
                <div className="profiles__bindings">
                  {p.appBindings.map((exe) => (
                    <span className="profiles__chip" key={exe}>
                      {exe}
                      <button type="button" onClick={() => void removeBinding(p, exe)} aria-label={`Remove ${exe}`}>
                        ×
                      </button>
                    </span>
                  ))}
                  <div className="profiles__add-binding">
                    <TextInput
                      placeholder="osu!.exe"
                      value={bindingDraft[p.id] ?? ""}
                      onChange={(e) => setBindingDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && void addBinding(p)}
                    />
                    <Button size="sm" variant="secondary" onClick={() => void addBinding(p)}>
                      Add
                    </Button>
                  </div>
                </div>
              </Field>
            </Card>
          ))
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New profile"
        description="Starts from your connected tablet's full area and primary monitor - refine it on the Tablet Area page."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!newName.trim()} onClick={createProfile}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createProfile()} placeholder="osu!" />
        </Field>
      </Modal>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename profile"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!renameValue.trim()} onClick={doRename}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void doRename()} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={doDelete}
        title="Delete profile"
        danger
        busy={busy}
        confirmLabel="Delete"
        message={toDelete ? `Delete "${toDelete.name}"? This can't be undone.` : ""}
      />
    </Page>
  );
}
