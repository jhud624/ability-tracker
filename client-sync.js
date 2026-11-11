// Shared by the browser and deterministic node:test fixtures; no DOM or storage.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoachClientSync = factory();
})(globalThis, function () {
  function createClientSync({ send, onChange = () => {} }) {
    const state = { data: null, summary: null, backupWarning: "", saveStatus: "", saveSequence: 0, writeError: "", refreshErrors: {}, pendingWrites: 0, pendingIntents: 0, pendingCurrentIntents: 0, intentNotice: "", receiptHead: null, needsReconcile: false, recoveryRequired: false, recoveryWarning: "" };
    let writes = Promise.resolve();
    let intents = Promise.resolve();
    let epoch = 0;
    let version = 0;
    let recoveryEpoch = 0;
    const activityIntents = new Set();
    let head = null;
    const reads = new Map();
    const autosaves = new Map();
    const emit = () => onChange(state);
    const generation = (value) => String(value?.restored_at || "");
    const revision = (value) => Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : null;
    function currentOrNewer(value) {
      if (revision(value) === null) return false;
      if (!head) return true;
      const incoming = generation(value), current = generation(head);
      // Restores reset revisions. The timestamp is an ordering hint, not a
      // fenced generation: inherited racing writers can remove it. Current
      // authoritative reads that violate this hint require visible resync.
      if (incoming !== current) return Boolean(incoming) && incoming > current && Number.isFinite(Date.parse(incoming));
      return value.revision >= head.revision;
    }
    const matchesHead = (value) => head && revision(value) === head.revision && generation(value) === generation(head);
    function invalidateSummary() { version += 1; state.summary = null; }
    function recoveryGuard() {
      const captured = recoveryEpoch;
      const blockedAtCapture = state.recoveryRequired;
      const isCurrent = () => !blockedAtCapture && captured === recoveryEpoch && !state.recoveryRequired;
      return { isCurrent, assertCurrent() {
        if (isCurrent()) return;
        const error = new Error("No save was sent: this edit was canceled by recovery. Review displayed state before making a new edit.");
        error.notSent = true;
        error.cancelledIntent = true;
        throw error;
      } };
    }
    function countCurrentIntents() {
      state.pendingCurrentIntents = [...activityIntents].filter(intent => intent.isCurrent()).length;
    }
    function invalidateCapturedIntents(message) {
      if (state.pendingCurrentIntents) state.intentNotice = message;
      recoveryEpoch += 1; // Resync never revalidates an earlier captured intent.
      countCurrentIntents();
    }
    function recovery(message) {
      state.recoveryRequired = true;
      invalidateCapturedIntents("Earlier pending edits were canceled by recovery. Review displayed state before making a new edit.");
      state.recoveryWarning = message + " Refresh saved state to explicitly resync before editing. Recovery still needs operator review.";
      invalidateSummary();
    }
    function applyState(value, partial = false, authoritative = false, resync = false) {
      const ordered = currentOrNewer(value);
      const confirmsRecovery = resync && state.recoveryRequired && matchesHead(value);
      if (ordered && head && generation(value) !== generation(head)) {
        invalidateCapturedIntents("Earlier pending edits were canceled after a restore. Review displayed state before making a new edit.");
      }
      if (!ordered && !authoritative) {
        state.needsReconcile = true;
        recovery("The save was acknowledged but its revision/restore order is inconsistent; refresh to inspect the latest server snapshot.");
        return false;
      }
      if (!ordered) recovery("Recovery mismatch: the latest server snapshot has unexpected revision/restore metadata. It is displayed for inspection.");
      head = { revision: value.revision, restored_at: value.restored_at || null };
      state.receiptHead = { ...head };
      if (partial) {
        // A receipt versions only the affected fields. Never relabel retained
        // plans/goals/completions as a complete snapshot of that revision.
        state.needsReconcile = true;
      } else {
        state.data = value;
        state.needsReconcile = false;
        if (confirmsRecovery && ordered) {
          state.recoveryRequired = false;
          if (state.saveStatus === "blocked") { state.saveStatus = ""; state.writeError = ""; }
          state.recoveryWarning = "Resynced to the latest server snapshot after a recovery mismatch. Recovery still needs operator review.";
        }
      }
      invalidateSummary();
      return true;
    }
    function write(path, options, intent = recoveryGuard()) {
      epoch += 1; // Invalidate reads at enqueue time, before any network work.
      state.saveSequence += 1;
      state.pendingWrites += 1;
      state.saveStatus = "pending";
      state.writeError = "";
      state.summary = null;
      emit();
      const operation = writes.then(async () => {
        try {
          intent.assertCurrent();
          if (state.recoveryRequired) {
            const error = new Error("No save was sent: refresh saved state to resync after the recovery mismatch.");
            error.notSent = true;
            throw error;
          }
          const value = await send(path, options, intent);
          if (revision(value) === null) throw new Error("The save response was incomplete. Refresh saved state before trying again.");
          const fullState = value && Object.hasOwn(value, "active_plan");
          const accepted = applyState(value, !fullState);
          // A read or a partial receipt is never proof of a successful backup.
          // Full-state write replies use absence of storage_warnings for success.
          if (accepted && (fullState || Array.isArray(value.storage_warnings))) {
            state.backupWarning = (value.storage_warnings || []).join(" ");
          }
          state.saveStatus = "saved";
          state.writeError = "";
          return value;
        } catch (error) {
          // A lost HTTP acknowledgement may follow a committed write. Never
          // replay it or claim that it was not saved; a read can verify state.
          state.saveStatus = error.notSent ? "blocked" : "unconfirmed";
          state.writeError = error.message || "The save response was unavailable.";
          throw error;
        } finally {
          state.pendingWrites -= 1;
          emit();
        }
      });
      writes = operation.catch(() => {});
      return operation;
    }
    async function read(path, options, channel, resync = false) {
      const id = (reads.get(channel) || 0) + 1;
      reads.set(channel, id);
      // Wait for writes already queued, including writes enqueued while waiting.
      let started;
      do { started = epoch; await writes; } while (started !== epoch);
      const dataVersion = version;
      const fresh = () => reads.get(channel) === id && epoch === started;
      try {
        const value = await send(path, options, { isCurrent: () => fresh() && (channel !== "summary" || version === dataVersion) });
        if (!fresh()) return null;
        if (channel === "state") {
          if (revision(value) === null) throw new Error("The saved state response was incomplete.");
          applyState(value, false, true, resync);
        } else {
          if (version !== dataVersion) return null;
          if (state.needsReconcile || state.recoveryRequired || !state.data || revision(value) !== state.data.revision || generation(value) !== generation(state.data)) {
            state.refreshErrors.summary = "The summary changed. Refresh saved state before copying it.";
            emit();
            return null;
          }
          state.summary = value;
        }
        delete state.refreshErrors[channel];
        emit();
        return value;
      } catch (error) {
        if (!fresh() || (channel === "summary" && version !== dataVersion)) return null;
        state.refreshErrors[channel] = error.message || "The refresh response was unavailable.";
        emit();
        return null;
      }
    }
    function request(path, options = {}) {
      const { coalesce = false, autosaveKey, resync = false, intent, ...transportOptions } = options;
      const method = String(options.method || "GET").toUpperCase();
      if (!["GET", "HEAD"].includes(method)) {
        if (state.recoveryRequired) {
          state.writeError = "No save was sent: refresh saved state to resync after the recovery mismatch.";
          state.saveStatus = "blocked";
          emit();
          return Promise.reject(new Error(state.writeError));
        }
        if (coalesce && (typeof autosaveKey !== "string" || !autosaveKey)) {
          return Promise.reject(new Error("Automatic saves require a stable logical control identity."));
        }
        const key = typeof autosaveKey === "string" && autosaveKey ? JSON.stringify([method, path, autosaveKey]) : null;
        const previous = key && autosaves.get(key);
        if (coalesce && previous && previous.body === options.body) return previous.promise;
        const promise = write(path, transportOptions, intent);
        if (key) {
          const entry = { body: options.body, promise };
          autosaves.set(key, entry);
          const clear = () => { if (autosaves.get(key) === entry) autosaves.delete(key); };
          // Unconfirmed state belongs to this logical exercise/control. Another
          // control cannot replace it. Changing THIS control's payload or an
          // explicit submission is a new intent (including deliberate A-B-A).
          promise.then(clear, error => { if (error.notSent) clear(); });
        }
        return promise;
      }
      if (path === "/api/state") return read(path, transportOptions, "state", resync);
      if (path === "/api/coach-summary") return read(path, transportOptions, "summary");
      return send(path, transportOptions);
    }
    function activityIntent(run, intent = recoveryGuard()) {
      activityIntents.add(intent);
      epoch += 1;
      state.pendingIntents += 1;
      countCurrentIntents();
      emit();
      const operation = intents.then(() => intent.isCurrent() ? run(intent) : null).finally(() => {
        activityIntents.delete(intent);
        state.pendingIntents -= 1;
        countCurrentIntents();
        emit();
      });
      intents = operation.catch(() => {});
      return operation;
    }

    return { state, request, activityIntent, captureIntent: recoveryGuard };
  }
  return { createClientSync };
});
