# Coolify deployment

This app is now ready to run on Coolify as a Dockerfile-based service.

## Application settings

- Build pack: `Dockerfile`
- Port: `3001`
- Health check path: `/api/healthz`
- Persistent storage: mount a volume to `/app/uploads`
- Domain: point the production domain to Coolify, then attach it to this app

Coolify injects `PORT` automatically in many setups. The Dockerfile defaults to
`3001`, which matches the exposed container port.

## Required environment variables

Set these in Coolify before the first production deploy:

```bash
NEON_DATABASE_URL=
ADMIN_USERNAME=
ADMIN_PASSWORD=
ORDERS_USERNAME=
ORDERS_PASSWORD=
```

## Recommended environment variables

```bash
ADMIN_SESSION_SECRET=
ORDERS_SESSION_SECRET=
CAPTAIN_SESSION_SECRET=
AIR_MENU_SECRET=
AIR_MENU_QR_BASE_URL=https://www.redlanternrestaurant.in
CLOUDINARY_URL=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
OPENAI_API_KEY=
```

Alternatively, Cloudinary can be configured with:

```bash
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

## Migration checklist

1. Push this repo to the Git provider Coolify can access.
2. In Coolify, create a new application from that repository.
3. Select Dockerfile build and set the exposed port to `3001`.
4. Add the environment variables from the old Vercel project.
5. Add persistent storage for `/app/uploads`.
6. Deploy and open `/api/healthz`.
7. Sign in to `/admin`, then run **Database Health**.
8. Test `/home`, `/menu`, `/orders`, `/register`, `/captain`, and QR ordering.
9. Move DNS from Vercel to the Contabo/Coolify endpoint after the smoke test passes.

Keep the Vercel project online until DNS has propagated and the Coolify app has
served live traffic successfully.
