import { apply as applyPiAi, Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';

// Pin the peer version and exercise this factory in integration tests. The public
// adapter plugin builds its own protocol snapshot; only registration is captured.
// No global fetch, shared settings, sibling adapter or OAuth record is modified.
export function buildChatAdapter(ctx, profile) {
  let adapter;
  const scope = {
    fiber: ctx.fiber,
    logger: ctx.logger,
    get: ctx.get.bind(ctx),
    inject() {},
    on() { return () => {}; },
    llm: {
      registerAdapter(_routes, value) { adapter = value; return Object.assign(() => {}, { replace() {} }); },
      registerConfigurableProviders() { return { replace() {} }; },
      registerModelDiscovery() { return () => {}; },
    },
  };
  applyPiAi(scope, PiAiConfig({ providers: { 'xAI-CLIProxyAPI': profile } }));
  if (!adapter) throw new Error('官方适配器未能创建 Grok 路由；请检查 dsh 兼容版本');
  return adapter;
}
