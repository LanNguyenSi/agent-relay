# Contributing to agent-relay

Thanks for your interest. agent-relay is a VPS deployment relay for AI agents, run via Docker.

## Issues

- Bug reports: include repro steps, expected vs. actual, the relay command path (HTTP API, MCP, GitHub Action), and Docker / Node version where relevant.
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks:

   ```bash
   npm install
   npm run build
   npm test
   ```

4. For deployment-path changes, dogfood against a real VPS target (or against the example compose file `docker-compose.prod.example.yml`) before submitting.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/agent-relay.git
cd agent-relay
npm install
npm run build
npm test
```

For the deployed flavor: see `Dockerfile` and `docker-compose.prod.example.yml`.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
