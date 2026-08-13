# Frame Art Manager Documentation

## Overview

Frame Art Manager helps you organize and manage artwork for your Samsung Frame displays. Upload images, organize them with tags, and sync changes to your shared library. TV discovery, assignment, and display automation now live in the Home Assistant integration rather than the add-on UI.

## Accessing the Add-on

### After Installation

1. Go to **Settings** → **Add-ons** → **Frame Art Manager**
2. Ensure the add-on is started (check for green indicator)
3. Click **Open Web UI** to access the interface

### Alternative Access Methods

- **Direct URL**: `http://[your-home-assistant-ip]:8099`
- **Sidebar Panel**: Look for "Frame Art Manager" in the Home Assistant sidebar
- **Dashboard**: Add a Webpage card pointing to the add-on URL

### Adding to Dashboard

To add Frame Art Manager to any dashboard:

1. Edit your dashboard
2. Add a **Webpage Card**
3. Set URL to: `http://homeassistant.local:8099`
4. Adjust aspect ratio as desired (100% recommended)

## Interface Overview

The web interface has 4 main areas:
- **Gallery**: Browse and manage your images
- **Upload**: Add new images to your library
- **Tags**: Manage your tag library
- **Advanced**: System information and settings (including metadata viewer and sync details)

> **Fork note:** This fork installs alongside the original billyfw add-on (different
> repository, same slug — Home Assistant treats them as separate add-ons). Both map host
> port 8099, so stop the original add-on before starting this one.

## Configuration

### Home Label (Optional)

Set the **Home** field to a nickname like `Madrone` so future automations can tell which location this add-on instance belongs to. The value is optional today but is passed to the backend for upcoming features.

### Git Sync (Optional)

To enable Git synchronization of your frame art library:

1. Go to **Settings** → **Add-ons** → **Frame Art Manager** → **Configuration**
2. Paste your SSH private key in the `ssh_private_key` field
3. Set `git_remote_host_alias` to match your Git remote host (default: `github-billy`)
4. Enable `git_auto_pull_on_startup` and/or `git_auto_push_on_change` (both default to **off** in this fork — the library is expected to be a local-only git repo with no remote)
5. Save and restart the add-on

**To get your SSH private key:**
- From Terminal & SSH add-on: `cat ~/.ssh/id_ed25519`
- Copy the entire output including `-----BEGIN` and `-----END` lines

**Note**: The private key is stored securely in the add-on's configuration and is never exposed in logs.

## Rotating Collages (Fluid Groups)

A **collage group** is a standing recipe for building matted collages out of tagged photos:
which tags to draw from, how the matte looks, which templates may be used, and the single
tag the outputs carry. Groups are managed in the collage builder's **Collage groups** panel.

A group runs in one of two modes:

- **Coverage** — one run builds a whole batch, enough collages that every fittable photo
  appears at least once, replacing the group's previous batch.
- **Fluid** — the group holds exactly **one** collage at a time, and each step replaces it
  with a new one. This is the rotating mode described below.

### Setting up a fluid group

1. Open the collage builder → **Collage groups** → **New group**.
2. Pick the **source tags** (the photo pool), a **template** set and the matte.
3. Set the **output tag** — for example `hawaii-collage`. This is the *only* tag the
   generated collages carry; nothing is inherited from the photos.
4. Choose mode **Fluid** and save.
5. On the TV side, point that TV's tagset at the output tag. Because a fluid group keeps
   exactly one collage alive, exactly one image ever matches the tagset.

You can advance the rotation by hand at any time with the group's **Advance now** button.

> Switching an existing coverage group to fluid mode is destructive by design: the first
> step collapses that group's whole batch down to the single rotating collage, because they
> all share the output tag the TV rotates on. Collages you want to keep should be promoted
> (below) or built outside a group first.

Each step fills the collage from photos the current cycle has not shown yet, padding with
the least recently used ones when the pool runs short. Once every photo has been shown the
cycle starts over. A newly tagged photo joins the *current* cycle immediately — it does not
wait for the next one. The panel shows how far through the cycle the group is.

### Advancing the rotation from Home Assistant

`POST /api/collage/groups/<name>/next` is one atomic step: it renders the next collage,
registers it, and only then deletes the one it replaces — so a failed render leaves the
current collage on the TV rather than emptying the rotation. Nothing about the shuffler
integration changes; the automation just calls the endpoint and then pushes as usual.

```yaml
# configuration.yaml
rest_command:
  frame_art_next_hawaii:
    url: "http://homeassistant.local:8099/api/collage/groups/hawaii/next"
    method: POST
    content_type: "application/json"
    payload: "{}"
    timeout: 120        # a full 3840x2160 render takes a few seconds
```

```yaml
# automations.yaml
- alias: "Frame art — rotate the Hawaii collage"
  triggers:
    - trigger: time_pattern
      hours: "/6"
  actions:
    - action: rest_command.frame_art_next_hawaii
    # Let the integration pick up the new file, then push to the TV with
    # whichever service your shuffler setup uses for a refresh.
    - action: frame_art_shuffler.sync_library
```

The response reports the new collage, what it replaced, and cycle progress:

```json
{
  "success": true,
  "filename": "collage-hawaii-diptych-2-20260813-101500.jpg",
  "imageIds": ["maui-01.jpg", "maui-07.jpg"],
  "removed": ["collage-hawaii-triptych-3-20260813-041500.jpg"],
  "cycle": { "used": 6, "total": 24 },
  "entry": 17,
  "skipped": []
}
```

### Promoting a collage you want to keep

Rotation deletes are permanent — the collage file and its thumbnail are removed. What
survives is the **recipe**: the last 50 steps of each group stay in the rotation log.

In the group's card, open **Recent steps** to see the log. Each entry renders a preview on
demand (the collage itself may be long gone) and has a **Promote** button, which re-renders
that recipe as a permanent collage with tags of your choosing. A promoted collage is an
ordinary library image — it is not stamped with the group, so no later rotation step and no
coverage rebuild will ever remove it. Give it a tag other than the group's output tag,
otherwise it will join the TV's rotation alongside the live collage.

The same thing over the API:

```bash
curl -X POST http://homeassistant.local:8099/api/collage/promote \
  -H 'Content-Type: application/json' \
  -d '{"group": "hawaii", "entry": 17, "tags": ["keepsake"]}'
```

Cycle state and the rotation log live in `collage_state.json` beside `metadata.json`. It is
deliberately excluded from git sync: it is volatile per-instance state, not part of the
library. Deleting it costs the current cycle's memory and the promote log, nothing else.

## Storage Location

- Images are stored in: `/config/www/frame_art/library/`
- Thumbnails are stored in: `/config/www/frame_art/thumbs/`
- Metadata is stored in: `/config/www/frame_art/metadata.json`
- Collage rotation state is stored in: `/config/www/frame_art/collage_state.json` (volatile,
  git-ignored)

## Support

- **GitHub**: https://github.com/pixel-gifs/ha-frame-art-manager
- **Issues**: https://github.com/pixel-gifs/ha-frame-art-manager/issues
- **Full Documentation**: See the GitHub repository for detailed usage instructions

## Version

Current Version: 0.2.0

Last Updated: October 18, 2025
