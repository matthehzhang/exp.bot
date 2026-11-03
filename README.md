# exp.bot

* `index.html`: the landing page at **exp.bot** (GitHub Pages, `CNAME`).
* `portal/`: the fleet portal at **app.exp.bot**: sign in, orgs and invites, every machine's
  state live, their events and files. Vite + React, deployed by Vercel (root directory
  `portal`). It follows the rig app's design language (ibrue/expbot-data
  `expbot/app/static/app.css`): keep the two in step.
* `supabase/`: the portal's backend, Supabase project `expbot-fleet`: the schema and its access
  rules (`migrations/`) and the `machine-upload` function.

## The fleet portal

```bash
cd portal && npm install && npm run dev      # http://localhost:5173
npm run check                                # build + tests
```

The Supabase URL and publishable key are in `portal/src/config.js` (public by design; override
with `VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY`). Row-level security decides what a signed-in
person sees: only the orgs they made or joined, and those orgs' machines, events and files.

**People.** Anyone can make an account. Owners and admins invite by email; the invite waits on
the invitee's home page once that email is confirmed. Owners change roles; an org always keeps an
owner.

**Machines.** An owner or admin adds a machine and gets its token once. On the machine, in the
rig repo, `python -m expbot.app.ctl fleet link <token>` links it: the rig app then reports its
state (its status lamps, job, code) every 30 s and its events, and uploads files through the
`machine-upload` function. A machine's token can only report as that machine; it reads nothing.

**Backend changes** go in a new file under `supabase/migrations/`, applied to `expbot-fleet`.

### One-time setup (by hand)

1. Supabase → expbot-fleet → Authentication → URL configuration: Site URL
   `https://app.exp.bot` (add `http://localhost:5173` to the redirect URLs for development).
2. Vercel: a project from this repo with root directory `portal` (framework Vite), and the domain
   `app.exp.bot` added to it.
3. DNS for exp.bot: a CNAME record `app` → `cname.vercel-dns.com`.
