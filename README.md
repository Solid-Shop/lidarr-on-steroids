# [lidarr-on-steroids](https://github.com/solid-shop/lidarr-on-steroids/)

```I got tired of looking for updates on this project, so I started my own forked version```

```BIG PROPS TO CREATOR: youegraillot```

[![GitHub last commit](https://img.shields.io/github/last-commit/solid-shop/lidarr-on-steroids?style=for-the-badge&logo=github)](https://github.com/solid-shop/lidarr-on-steroids)
[![Latest tag](https://img.shields.io/docker/v/solidshop/lidarr-on-steroids?style=for-the-badge&logo=docker)](https://hub.docker.com/r/solidshop/lidarr-on-steroids)
[![Docker pulls](https://img.shields.io/docker/pulls/solidshop/lidarr-on-steroids?style=for-the-badge&logo=docker)](https://hub.docker.com/r/solidshop/lidarr-on-steroids)

This repository bundles a modded version of Lidarr and Deemix into a docker image featuring :
  - Native Deemix integration as an indexer and downloader for Lidarr
  - Automatic Lidarr and Deemix configuration
  - Automatic conversion from any format with ffmpeg
  - Podman compatibility with rootless mode
  - **Per-track automatic and interactive search** injected into Lidarr's album page — cherry-pick individual songs without grabbing the whole album (see below)

This allows an easy deployment, with the advantage of having a direct control over Deemix indexing and downloader capacities into Lidarr :

!["Lidarr indexers"](https://github.com/solid-shop/lidarr-on-steroids/raw/main/.assets/lidarr-indexers.png "Lidarr indexers")

## Usage

### Parameters

| Parameter | Function |
| :----: | --- |
| `-p 8686` | Lidarr WebUI + track-picker API (`/picker-api/*`). A small Caddy reverse proxy inside the container fronts Lidarr on this port
| `-p 6595` | Deemix WebUI (still useful for direct ARL management). |
| `-e PUID=1000` | for UserID |
| `-e PGID=1000` | for GroupID |
| `-e AUTOCONFIG=true` | Enable automatic configuration - see below for explanation |
| `-e FLAC2CUSTOM_ARGS=""` | Sets arguments used when calling flac2custom.sh |
| `-e CLEAN_DOWNLOADS=true` | Enable cleaning empty folders in /downloads |
| `-e TRACK_PICKER_IMPORT_MODE=Move` | Lidarr import mode for cherry-picked tracks (`Move` or `Copy`). Default `Move`. |
| `-v /config` | Configuration files for Lidarr. |
| `-v /config_deemix` | Configuration files for Deemix. |
| `-v /downloads` | Path to your download folder for music. |
| `-v /music` | Music files. |

### Docker Run

```sh
docker run \
  --name lidarr \
  -p 8686:8686 \
  -p 6595:6595 \
  -v <path>:/config \
  -v <path>:/config_deemix \
  -v <path>:/downloads \
  -v <path>:/music \
  --restart unless-stopped \
 solidshop/lidarr-on-steroids
```

### Docker Compose

```yml
services:
  lidarr:
    image: solidshop/lidarr-on-steroids
    restart: unless-stopped
    ports:
      - "8686:8686" # Lidarr web UI
      - "6595:6595" # Deemix web UI (also proxies /picker-api → loopback sidecar)
    volumes:
      - <path>:/config
      - <path>:/config_deemix
      - <path>:/downloads
      - <path>:/music
```

## Automatic configuration

Deemix comes with optimal settings allowing Lidarr integration, in particular regarding the folder structure ("createCDFolder" is required for this to work). `DEEMIX_SINGLE_USER` environment variable is also set to `true` to allow the `setup` script to read the corresponding ARL.

The `setup` service will install the Deemix plugin. ~~This requires Lidarr to be restarted once.~~ Lidarr service will automatically restart once on plugin install.

In `AUTOCONFIG` mode (default), the only manual manipulation you'll only have to fill your Deezer credentials in Deemix web UI (port [6595](http://localhost:6595) by default). 

Use the **ARL tab** and paste your `arl` cookie value from a logged-in deezer.com browser session — Deezer's email/password auth is currently behind Akamai bot protection and is not usable from a server-side flow. 

Steps to get ARL token:
1. Login to Deezer.com
2. Open "Developer Tools" (usually ctrl+shift+I or F12) in your browser
3. For Chromium Browsers: Go to Storage Tab > Cookies (Other browsers you may need to search for this)
4. Find ARL and copy the value:
!["ARL_Token"](https://github.com/solid-shop/lidarr-on-steroids/raw/main/.assets/ARL_Token.png "ARL_Token")
5. Open new tab to Deemix page (http://<ip_address:6595>)
6. Open settings tab > Use ARL instead > Paste ARL and Force Update/Save

Once the `/config_deemix/login.json` is filled with the resulting ARL, the `setup` will be able to create the following :
  - /music root folder if no other root folder is configured
  - Delay profile allowing Deemix to be used by automatic search
  - Deemix as an indexer
  - Deemix as a download client
  - Flac2Custom script connection if `FLAC2CUSTOM_ARGS` is set
  - clean-downloads script connection to keep your downloads folder *clean* after each imports

In case you don't want the automagical part, just set `AUTOCONFIG` environment variable to `false`.

## Per-track search and cherry-pick

Lidarr only searches at album granularity, but Deemix can download individual tracks. Although it is a bit of a Frankensteins Monster, this image ships a small Node sidecar plus a script that gets injected into Lidarr's compiled web UI at container start.

!["Per-track search buttons"](https://github.com/solid-shop/lidarr-on-steroids/raw/main/.assets/track-search-buttons.png "Per-track search buttons")
*(if you can't see them, hard-reload the album page after a fresh container start)*

### What each icon does

- **🔍 Magnifying glass — automatic search.** Sends the track's title plus the artist/album from the page context to deemix, with a penalty for `live`/`remix`/`instrumental`/`karaoke`/`cover` unless those words were in the original title. Top candidate is queried via Deemix if it scores high enough. If no candidate is confident enough you get a "no confident match" nothing is queued.
- **👤 Person — interactive search.** Opens a Lidarr-styled modal with the track title pre-filled. Search Deezer, see every candidate with cover/title/artist/album/duration, and hit the green **Grab** button on the one you want.
- **Floating "Pick Tracks" pill** (bottom-right of every Lidarr page) — global escape hatch when you're not on an album page or want to search free-text.

### The download → import flow

1. Whichever way you trigger it, the chosen track gets sent to Deemix's `/api/addToQueue`.
2. Deemix downloads to `/downloads/<artist>/<artist> - <album>/<track>.<ext>` (same path Lidarr's normal Deemix download client uses).
3. The custom scripts polls Deemix's queue until nothing is actively downloading.
4. It then calls Lidarr's **Manual Import API** to scan `/downloads`, overriding the partial-album rejections that Lidarr would otherwise apply (`"Has missing tracks"`, `"Album match is not close enough"`) — same as clicking *Import* on a yellow row in Lidarr's manual import dialog. Default mode is `Move`, set `TRACK_PICKER_IMPORT_MODE=Copy` if you prefer copying.
5. After the import command completes, the sidecar clears Deemix's finished-downloads list, removes the now-orphan rows from Lidarr's queue (with `removeFromClient=false` so no files are ever asked to be deleted by Deemix), and sweeps any empty subfolders under `/downloads`.

The un-picked tracks on the album stay "missing" in Lidarr — unmonitor them if you want the album to register as complete.

If the auto-import doesn't trigger for some reason, manual import will be required.


## Audio files conversion

The image uses a modded version of lidarr-flac2mp3 allowing conversion from any format.

To enable conversion on Lidarr import, create a new Connection to a Custom Script. You can also provide your own custom conversion script, see [lidarr-flac2mp3](https://github.com/solid-shop/lidarr-flac2mp3) for more information.

In `AUTOCONFIG`, if `FLAC2CUSTOM_ARGS` is set and no other connection to flac2* is found, this step done for you :

!["Lidarr custom script settings"](https://github.com/solid-shop/lidarr-on-steroids/raw/main/.assets/lidarr-custom-script.png "Lidarr custom script settings")

## Acknowledgment

This project is just a compilation of various tools made possible by these projects :

- [Fork](https://github.com/youegraillot/lidarr-on-steroids) Forked version from here
- [Lidarr](https://github.com/Lidarr/Lidarr) and especially [ta264](https://github.com/ta264) for the plugin integration
- [lidarr-flac2mp3](https://github.com/TheCaptain989/lidarr-flac2mp3) for the format conversion script
- [Deemix](https://deemix.app/) for the downloader backend
- [hotio](https://hotio.dev/) for the base docker image

Alternatively, you could use [Deemixrr](https://github.com/TheUltimateC0der/deemixrr) which pretty much offers the same functionalities without the *starr of the various Sonarr forks.
