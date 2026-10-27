'use strict';
// Structured finding fields (R10): schema, validation and the MR comment
// template. The AI never writes Markdown directly; ReviewX renders it.

const SEVERITIES = ['fatal', 'major', 'minor', 'suggestion'];
const SEV_RANK = { fatal: 0, major: 1, minor: 2, suggestion: 3 };
const SEV_SIGNAL = { fatal: '🔴 Fatal', major: '🟠 Major', minor: '🟡 Minor', suggestion: '🟢 Suggestion' };
const SEV_NAME = { fatal: 'Fatal', major: 'Major', minor: 'Minor', suggestion: 'Suggestion' };

const codeSchema = {
  type: 'object',
  properties: {
    language: { type: 'string', description: '代码语言，如 java、ts、go' },
    code: { type: 'string', description: '代码片段，保持原文' }
  },
  required: ['code']
};

function inputSchema(ruleNames) {
  const rule = { type: 'string', description: '该意见对应的规则名，只能取本次使用的规则之一；不属于任何规则时留空' };
  if (ruleNames.length) rule.enum = ruleNames.concat(['']);
  return {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: SEVERITIES, description: '严重程度：fatal 致命 / major 严重 / minor 一般 / suggestion 建议' },
      title: { type: 'string', description: '问题标题：一个短语点明问题本身，不超过 25 个字（英文不超过 12 个单词），不写原因和后果' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，如 正确性、安全' },
      summary: { type: 'string', description: '简述：一两句话说明哪处修改出了什么问题，不超过 60 个字（英文不超过 30 个单词）。后果、影响范围和触发条件写在 impact 里，修改建议写在 solutions 里，这里不要重复，也不要贴代码' },
      location: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库相对路径；无法定位到文件时为空字符串' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 }
        },
        required: ['path']
      },
      related_code: codeSchema,
      impact: {
        type: 'object',
        properties: {
          consequence: { type: 'string', description: '直接后果' },
          scope: { type: 'string', description: '影响范围' },
          trigger: { type: 'string', description: '触发条件' }
        },
        required: ['consequence', 'scope', 'trigger']
      },
      solutions: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          properties: { description: { type: 'string', description: '可执行的修改建议' }, code: codeSchema },
          required: ['description']
        }
      },
      prevention: { type: 'array', items: { type: 'string' }, description: '预防措施' },
      rule,
      evidence: { type: 'string', description: '核实依据：「文件:行号」及对应代码。只用于校验，不会发布' }
    },
    required: ['severity', 'title', 'summary', 'location', 'impact', 'solutions', 'evidence']
  };
}

function str(v) { return typeof v === 'string' && v.trim().length > 0; }

function cleanCode(c) {
  if (!c || typeof c !== 'object' || typeof c.code !== 'string' || !c.code.trim()) return null;
  return { language: typeof c.language === 'string' ? c.language.trim().slice(0, 40) : '', code: c.code.replace(/\s+$/, '') };
}

// Returns { ok: true, finding } or { ok: false, errors: [field: reason] }.
function validateFinding(input, ruleNames) {
  const errors = [];
  const x = input && typeof input === 'object' ? input : {};
  if (!SEVERITIES.includes(x.severity)) errors.push('severity：应为 fatal、major、minor、suggestion 之一');
  if (!str(x.title)) errors.push('title：必填，不能为空');
  if (!str(x.summary)) errors.push('summary：必填，不能为空');
  const loc = x.location;
  if (!loc || typeof loc !== 'object') errors.push('location：必填，至少包含 path（无法定位时为空字符串）');
  else {
    if (typeof loc.path !== 'string') errors.push('location.path：必填，应为字符串（可为空）');
    else if (/^([a-zA-Z]:|[\\/])|(^|[\\/])\.\.([\\/]|$)/.test(loc.path.trim())) errors.push('location.path：应为仓库相对路径');
    for (const k of ['start_line', 'end_line']) {
      if (loc[k] !== undefined && loc[k] !== null && !(Number.isInteger(loc[k]) && loc[k] > 0)) errors.push('location.' + k + '：应为正整数');
    }
    if (Number.isInteger(loc.start_line) && Number.isInteger(loc.end_line) && loc.end_line < loc.start_line) errors.push('location.end_line：不能小于 start_line');
  }
  const im = x.impact;
  if (!im || typeof im !== 'object') errors.push('impact：必填，包含 consequence、scope、trigger');
  else for (const k of ['consequence', 'scope', 'trigger']) if (!str(im[k])) errors.push('impact.' + k + '：必填，不能为空');
  if (!Array.isArray(x.solutions) || !x.solutions.length) errors.push('solutions：必填，至少 1 项');
  else x.solutions.forEach((s, i) => { if (!s || !str(s.description)) errors.push('solutions[' + i + '].description：必填，不能为空'); });
  if (!str(x.evidence)) errors.push('evidence：必填，写明「文件:行号」及对应代码');
  if (x.tags !== undefined && !(Array.isArray(x.tags) && x.tags.every((t) => typeof t === 'string'))) errors.push('tags：应为字符串数组');
  if (x.prevention !== undefined && !(Array.isArray(x.prevention) && x.prevention.every((t) => typeof t === 'string'))) errors.push('prevention：应为字符串数组');
  if (x.rule !== undefined && x.rule !== null && x.rule !== '') {
    if (typeof x.rule !== 'string' || !ruleNames.includes(x.rule)) errors.push('rule：只能是本次使用的规则名之一（' + (ruleNames.join('、') || '本次没有使用规则') + '），不属于任何规则时留空');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    finding: {
      severity: x.severity,
      title: x.title.trim(),
      tags: (x.tags || []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
      summary: x.summary.trim(),
      location: {
        path: loc.path.trim().replace(/\\/g, '/'),
        start_line: Number.isInteger(loc.start_line) ? loc.start_line : null,
        end_line: Number.isInteger(loc.end_line) ? loc.end_line : null
      },
      related_code: cleanCode(x.related_code),
      impact: { consequence: im.consequence.trim(), scope: im.scope.trim(), trigger: im.trigger.trim() },
      solutions: x.solutions.map((s) => ({ description: s.description.trim(), code: cleanCode(s.code) })),
      prevention: (x.prevention || []).map((t) => t.trim()).filter(Boolean),
      rule: typeof x.rule === 'string' ? x.rule : '',
      evidence: x.evidence.trim()
    }
  };
}

function locText(loc) {
  if (!loc || !loc.path) return '未定位到具体文件';
  let s = loc.path;
  if (loc.start_line) s += ':' + loc.start_line + (loc.end_line && loc.end_line !== loc.start_line ? '-' + loc.end_line : '');
  return s;
}

// Severity high→low, then path, then line (R16 排列顺序).
function sortFindings(list) {
  return list.slice().sort((a, b) =>
    SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
    (a.location.path || '￿').localeCompare(b.location.path || '￿') ||
    (a.location.start_line || 0) - (b.location.start_line || 0));
}

function fence(code) {
  let f = '```';
  while (code.code.includes(f)) f += '`';
  return f + (code.language || '') + '\n' + code.code + '\n' + f;
}

// MR comment body (ReviewX PRD 6.3 MR 评论规范).
function renderComment(f) {
  const out = [];
  out.push('### ' + SEV_SIGNAL[f.severity] + ' ' + f.title, '');
  out.push('**问题描述**：');
  out.push('- 严重级别：' + SEV_NAME[f.severity]);
  if (f.tags && f.tags.length) out.push('- 标签：' + f.tags.map((t) => '`#' + t + '`').join(' '));
  out.push('- 简述：' + f.summary, '');
  out.push('**问题位置**：`' + locText(f.location) + '`', '');
  if (f.related_code) out.push(fence(f.related_code), '');
  out.push('**影响分析**：');
  out.push('- **直接后果**：' + f.impact.consequence);
  out.push('- **影响范围**：' + f.impact.scope);
  out.push('- **触发条件**：' + f.impact.trigger, '');
  out.push('**解决方案**：');
  f.solutions.forEach((s, i) => {
    out.push((f.solutions.length > 1 ? (i + 1) + '. ' : '') + s.description);
    if (s.code) out.push(fence(s.code));
  });
  if (f.prevention && f.prevention.length) {
    out.push('', '**预防措施**：');
    for (const p of f.prevention) out.push('- ' + p);
  }
  return out.join('\n');
}

module.exports = { SEVERITIES, SEV_RANK, inputSchema, validateFinding, renderComment, sortFindings, locText };
