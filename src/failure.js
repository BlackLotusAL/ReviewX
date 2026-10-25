'use strict';
// A review failure carries what the user needs (R17): which step, why, what
// to do next, and whether the queue keeps going.
//   kind 'env'     → environment-level, stops the whole queue
//   kind 'step'    → only this review (steps 1–5)
//   kind 'ai'      → steps 6–7, stops the queue to save tokens
//   kind 'context' → step 6 context overflow, only this review
class ReviewFailure extends Error {
  constructor({ step, kind, code, title, reason, next, detail, unread }) {
    super(title || reason);
    this.step = step;
    this.kind = kind;
    this.code = code;
    this.title = title;
    this.reason = reason;
    this.next = next || '';
    this.detail = detail || '';
    this.unread = unread || null;
  }
  get stopsQueue() { return this.kind === 'env' || this.kind === 'ai'; }
  toJSON() {
    return { step: this.step, kind: this.kind, code: this.code, title: this.title, reason: this.reason, next: this.next, detail: this.detail, unread: this.unread, stopsQueue: this.stopsQueue };
  }
}

class Stopped extends Error {
  constructor(reason) { super(reason || '已主动停止'); this.reason = reason || '已主动停止'; }
}

module.exports = { ReviewFailure, Stopped };
