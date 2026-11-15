export type Env = Cloudflare.Env;

export type AppEnv = {
  Bindings: Env;
  Variables: { sessionId: string };
};
