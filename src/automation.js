'use strict';
// Automation, phase 1 (R26–R28, R17):
//   - pause / resume: environment-level errors stop the queue and pause all
//     automation until the user clicks「恢复」
//   - auto fetch (R27): every N minutes while ReviewX runs
//   - auto review (R28): after each fetch, queue new MRs and new versions
// State is kept in <dataDir>/automation.json so it survives restarts.
const path = require('path');
const { readJSON, writeJSONAtomic } = require('./util');

const TICK_MS = 15000;

function skipHit(keywords, title) {
  const t = String(title || '').toLowerCase();
  return (keywords || []).some((w) => w && t.includes(String(w).toLowerCase()));
}

class Automation {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.store.dir, 'automation.json');
    this.state = null;
    this.timer = null;
    this.startedAt = Date.now();
    this.nextFetchAt = null;
  }

  get cfg() { return this.app.cfg; }
  get log() { return this.app.logger; }

  load() {
    const s = readJSON(this.file, null);
    this.state = Object.assign({
      version: 1,
      paused: null,       // { reason, next, code, source, at }
      lastFetch: null,    // { at, mode: 'manual' | 'auto' }
      switches: { newMr: false, newVersion: false }, // auto-review switches as last seen
      seen: {},           // pid/iid → true: MRs already seen in the MR list
      handled: {},        // pid/iid → updatedAt: versions not to auto-queue again
      deferred: {}        // pid/iid → true: re-check when the running review ends
    }, s || {});
    // A switch turned on since last time (first run, or edited in the config file
    // while ReviewX was stopped): the MR list as it is now is the baseline.
    if (this.switchTurnedOn(this.state.switches)) this.takeBaseline();
    this.state.switches = this.currentSwitches();
    delete this.state.reviewOn;
    this.save();
  }

  save() { writeJSONAtomic(this.file, this.state); }

  reviewEnabled() { return Boolean(this.cfg.autoReviewNewMr || this.cfg.autoReviewNewVersion); }
  currentSwitches() { return { newMr: Boolean(this.cfg.autoReviewNewMr), newVersion: Boolean(this.cfg.autoReviewNewVersion) }; }
  // R28 基线 is taken whenever either auto-review switch goes from off to on.
  switchTurnedOn(prev) {
    const p = prev || {};
    return (this.cfg.autoReviewNewMr && !p.newMr) || (this.cfg.autoReviewNewVersion && !p.newVersion);
  }

  // R28 基线: MRs in the list now, and their current versions, are not auto-reviewed.
  takeBaseline() {
    let n = 0;
    for (const p of this.app.activeProjects()) {
      for (const m of this.app.openMrs(p.id)) {
        const key = p.id + '/' + m.iid;
        this.state.seen[key] = true;
        this.state.handled[key] = m.updatedAt;
        n++;
      }
    }
    this.state.deferred = {};
    this.log.info('automation.baseline mrs=' + n);
  }

  start() {
    this.nextFetchAt = this.startedAt + this.cfg.autoFetchIntervalMinutes * 60000;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ---- pause / resume (R17) ----
  isPaused() { return Boolean(this.state && this.state.paused); }

  pause(info) {
    if (this.state.paused) return;
    this.state.paused = Object.assign({ at: Date.now() }, info);
    this.save();
    this.log.error('automation.paused code=' + (info.code || '') + ' reason=' + info.reason);
    this.app.notify('队列已停止，自动化已暂停：' + info.reason);
    this.app.changed();
  }

  resume() {
    if (!this.state.paused) return false;
    this.state.paused = null;
    this.save();
    this.log.info('automation.resume by=user');
    this.app.changed();
    this.app.engine.pump();
    return true;
  }

  // ---- settings (R26) ----
  // Called after the settings were saved and applied to cfg.
  onSettingsChanged(prev) {
    if (this.switchTurnedOn({ newMr: prev.autoReviewNewMr, newVersion: prev.autoReviewNewVersion })) this.takeBaseline();
    this.state.switches = this.currentSwitches();
    this.save();
    if (prev.autoFetchIntervalMinutes !== this.cfg.autoFetchIntervalMinutes || (!prev.autoFetch && this.cfg.autoFetch)) {
      const base = (this.state.lastFetch && this.state.lastFetch.at) || this.startedAt;
      this.nextFetchAt = Math.max(base + this.cfg.autoFetchIntervalMinutes * 60000, Date.now() + 60000);
    }
  }

  // ---- auto fetch (R27) ----
  tick() {
    if (!this.cfg.autoFetch || this.isPaused() || !this.nextFetchAt) return;
    if (Date.now() < this.nextFetchAt) return;
    this.nextFetchAt = Date.now() + this.cfg.autoFetchIntervalMinutes * 60000;
    if (this.app.fetch.active) { this.log.info('mr.fetch auto skipped reason=previous_fetch_running'); return; }
    if (!this.app.activeProjects().length) return;
    try {
      this.app.startFetch(null, 'auto');
    } catch (e) {
      this.log.warn('mr.fetch auto failed to start ' + e.message);
    }
  }

  // Every finished fetch, manual or automatic, restarts the countdown.
  // full: every watched project was fetched (not a single-project retry).
  onFetchDone(mode, results, full) {
    const at = Date.now();
    this.state.lastFetch = { at, mode };
    this.nextFetchAt = at + this.cfg.autoFetchIntervalMinutes * 60000;
    // R27/R17: an environment-level error pauses all automation.
    const env = results.find((r) => r.env);
    const allNetwork = full && results.length > 0 && results.every((r) => r.code === 'NETWORK_ERROR');
    if (env || allNetwork) {
      const e = env || results[0];
      this.app.engine.stopQueue('队列已停止 · ' + e.reason);
      this.pause({ reason: e.reason, next: e.next, code: e.code, source: '获取 MR' });
    } else {
      this.autoReview();
    }
    this.save();
  }

  // ---- auto review (R28) ----
  autoReview(onlyKey) {
    if (!this.reviewEnabled() || this.isPaused()) return [];
    const queued = [];
    for (const p of this.app.activeProjects()) {
      if (this.app.removing && this.app.removing.has(p.id)) continue; // being removed (R22)
      for (const m of this.app.openMrs(p.id)) {
        const key = p.id + '/' + m.iid;
        if (onlyKey && key !== onlyKey) continue;
        if (skipHit(this.cfg.skipKeywords, m.title)) {
          // Not marked as seen: once the keyword is gone it is judged again.
          if (!this.state.seen[key]) this.log.info('review.auto_skip !' + m.iid + ' project=' + p.id + ' reason=keyword');
          continue;
        }
        const firstSeen = !this.state.seen[key];
        this.state.seen[key] = true;
        if (this.state.handled[key] === m.updatedAt) continue;
        const info = this.app.reviewInfo(p.id, m.iid);
        const isNew = firstSeen && info.attempts.length === 0;
        const isNewVersion = Boolean(info.latest && info.latest.mrUpdatedAt !== m.updatedAt);
        if (!((this.cfg.autoReviewNewMr && isNew) || (this.cfg.autoReviewNewVersion && isNewVersion))) continue;
        const job = this.app.engine.find(p.id, m.iid);
        if (job && job.status === 'queued') { this.state.handled[key] = m.updatedAt; continue; }
        if (job) { this.state.deferred[key] = true; continue; } // re-check when it ends
        try {
          this.app.engine.enqueue(p.id, m.iid, 'auto');
          this.state.handled[key] = m.updatedAt;
          queued.push('!' + m.iid);
        } catch (e) {
          this.log.warn('review.auto_enqueue !' + m.iid + ' failed ' + e.message);
        }
      }
    }
    if (queued.length) this.app.notify('已自动加入检视队列：' + queued.join('、'));
    this.save();
    return queued;
  }

  // R28 去重: a new version that showed up during a review is queued once it ends.
  // A project being removed gets no more deferred reviews.
  forgetProject(pid) {
    if (!this.state) return;
    for (const key of Object.keys(this.state.deferred)) if (key.startsWith(pid + '/')) delete this.state.deferred[key];
    this.save();
  }

  onReviewEnded(pid, iid) {
    const key = pid + '/' + iid;
    if (!this.state || !this.state.deferred[key]) return;
    delete this.state.deferred[key];
    this.autoReview(key);
  }

  view() {
    const s = this.state || {};
    return {
      paused: s.paused || null,
      autoFetch: this.cfg.autoFetch,
      intervalMinutes: this.cfg.autoFetchIntervalMinutes,
      nextFetchAt: this.cfg.autoFetch && !this.isPaused() ? this.nextFetchAt : null,
      lastFetch: s.lastFetch || null,
      autoReview: this.reviewEnabled()
    };
  }
}

module.exports = { Automation, skipHit };
