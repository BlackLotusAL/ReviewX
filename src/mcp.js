'use strict';
// Local MCP server (streamable HTTP, JSON responses) exposing the two
// submission tools to OpenCode: report_finding and finish_review (R10).
// Each review gets a random URL token; only that review's session answers.
const crypto = require('crypto');
const { inputSchema } = require('./finding');

const PROTOCOL = '2025-03-26';

class McpHub {
  constructor() {
    this.sessions = new Map();
  }

  // handlers: { ruleNames, report(input) -> {ok, text}, finish(input) -> {ok, text} }
  open(handlers) {
    const token = crypto.randomBytes(18).toString('hex');
    this.sessions.set(token, handlers);
    return token;
  }

  close(token) { this.sessions.delete(token); }

  tools(h) {
    return [
      {
        name: 'report_finding',
        description: '提交一条已核实的检视意见。每次调用只提交一条；校验不通过时会返回具体字段和原因，请修正后重新提交。',
        inputSchema: inputSchema(h.ruleNames)
      },
      {
        name: 'finish_review',
        description: '全部差异文件读完、所有意见提交后调用，结束本次检视。仍有未读的差异文件时会返回未读清单，请读完后再调用。',
        inputSchema: { type: 'object', properties: { note: { type: 'string', description: '可选：检视小结' } } }
      }
    ];
  }

  async handle(token, body) {
    const h = this.sessions.get(token);
    if (!h) return { status: 404, json: { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null } };
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    const out = [];
    for (const m of msgs) {
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') { out.push({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null }); continue; }
      if (m.id === undefined || m.id === null) continue; // notification
      out.push(await this.dispatch(h, m));
    }
    if (!out.length) return { status: 202 };
    return { status: 200, json: batch ? out : out[0] };
  }

  async dispatch(h, m) {
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: (m.params && m.params.protocolVersion) || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'reviewx', version: '1.0.0' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.tools(h) });
      case 'tools/call': {
        const name = m.params && m.params.name;
        const args = (m.params && m.params.arguments) || {};
        let r;
        if (name === 'report_finding') r = await h.report(args);
        else if (name === 'finish_review') r = await h.finish(args);
        else r = { ok: false, text: '未知工具：' + name };
        return ok({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
      }
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
    }
  }
}

module.exports = { McpHub };
