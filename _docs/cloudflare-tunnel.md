---
title: cloudflare tunnel setup
topic: guides
chapter: 3
description: configure cloudflare tunnel for public access to your gronka instance
---

configure cloudflare tunnel for public access to your gronka instance.

## quick start

the tunnel service is configured as a docker compose profile, so it won't start automatically. to start it:

```bash
docker compose --profile tunnel up -d
```

or to see logs:

```bash
docker compose --profile tunnel up
```

## setup options

### option 1: using tunnel token (recommended for docker)

1. get your tunnel token from cloudflare dashboard:
   - go to zero trust → networks → tunnels
   - click on your tunnel → configure
   - copy the token

2. add to your `.env` file:

   ```env
   CLOUDFLARE_TUNNEL_TOKEN=your-token-here
   ```

3. update `config/cloudflared-config.yml`:
   - set your hostname (replace `cdn.yourdomain.com`)
   - the service url should be `http://app:3000` (already correct)

4. start the tunnel:

   ```bash
   docker compose --profile tunnel up -d
   ```

### option 2: using credentials file (docker)

1. create your tunnel and get credentials:

   ```bash
   cloudflared tunnel create gif-cdn
   ```

2. copy the credentials file to the config directory:

   ```bash
   cp ~/.cloudflared/<TUNNEL_UUID>.json ./config/credentials.json
   ```

3. update `config/cloudflared-config.yml`:

   ```yaml
   tunnel: <YOUR_TUNNEL_UUID>
   credentials-file: /etc/cloudflared/credentials.json

   ingress:
     - hostname: cdn.yourdomain.com
       service: http://app:3000
     - service: http_status:404
   ```

4. start the tunnel:

   ```bash
   docker compose --profile tunnel up -d
   ```

### option 3: manual setup (non-docker)

if you're running gronka without docker, you can set up cloudflare tunnel manually.

#### prerequisites

- cloudflare account (free tier works)
- domain added to cloudflare (dns managed by cloudflare)
- local server running on port 3000

#### step 1: install cloudflared

**linux/debian:**

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

**windows:**

using chocolatey (recommended):

```powershell
choco install cloudflared
```

or download manually from: https://github.com/cloudflare/cloudflared/releases/latest

**mac:**

```bash
brew install cloudflared
```

#### step 2: authenticate with cloudflare

this will open your browser to authorize the tunnel:

```bash
cloudflared tunnel login
```

- select your domain from the list
- click "authorize" in the browser
- the credentials file will be saved to `~/.cloudflared/cert.pem` (linux/mac) or `%USERPROFILE%\.cloudflared\cert.pem` (windows)

#### step 3: create a tunnel

```bash
cloudflared tunnel create gif-cdn
```

this will:
- create a tunnel named "gif-cdn"
- generate a uuid for the tunnel
- save credentials to `~/.cloudflared/<TUNNEL_UUID>.json` (linux/mac) or `%USERPROFILE%\.cloudflared\<TUNNEL_UUID>.json` (windows)

**important:** copy the tunnel uuid that's displayed - you'll need it for the next steps.

#### step 4: configure the tunnel

1. navigate to your cloudflared config directory:

   **linux/mac:**
   ```bash
   cd ~/.cloudflared
   ```

   **windows:**
   ```powershell
   cd $env:USERPROFILE\.cloudflared
   ```

2. create or edit `config.yml`:

   ```yaml
   tunnel: <YOUR_TUNNEL_UUID>
   credentials-file: /home/user/.cloudflared/<TUNNEL_UUID>.json

   ingress:
     - hostname: cdn.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

   **replace:**
   - `<YOUR_TUNNEL_UUID>` - the uuid from step 3
   - `/home/user/.cloudflared/` - your actual path (windows: `C:\Users\<YOUR_USERNAME>\.cloudflared\`)
   - `cdn.yourdomain.com` - your desired subdomain (e.g., `cdn.example.com`)

#### step 5: setup dns record

1. go to [cloudflare dashboard](https://dash.cloudflare.com)
2. select your domain
3. go to **dns** → **records**
4. click **add record**
5. configure:
   - **type**: `CNAME`
   - **name**: `cdn` (or whatever subdomain you want)
   - **target**: `<YOUR_TUNNEL_UUID>.cfargotunnel.com`
   - **proxy status**: proxied (orange cloud) ✅
   - **ttl**: auto
6. click **save**

**note:** dns propagation can take a few minutes.

#### step 6: update your .env file

edit your `.env` file and update the cdn url:

```env
CDN_BASE_URL=https://cdn.yourdomain.com/gifs
```

replace `cdn.yourdomain.com` with your actual subdomain.

#### step 7: test the tunnel

1. make sure your express server is running:

   ```bash
   npm run server
   ```

2. in a new terminal, run the tunnel:

   ```bash
   cloudflared tunnel run gif-cdn
   ```

you should see:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
|  https://cdn.yourdomain.com                                                               |
+--------------------------------------------------------------------------------------------+
```

3. test the health endpoint:

   ```bash
   curl https://cdn.yourdomain.com/health
   ```

or visit in browser: `https://cdn.yourdomain.com/health`

#### step 8: run tunnel as a service (optional)

**linux (systemd):**

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

**windows:**

using nssm (non-sucking service manager):

1. download nssm: https://nssm.cc/download
2. extract and run `nssm.exe install CloudflaredTunnel`
3. configure:
   - **path**: `C:\path\to\cloudflared.exe` (or just `cloudflared` if in path)
   - **startup directory**: `C:\Users\<YOUR_USERNAME>\.cloudflared`
   - **arguments**: `tunnel run gif-cdn`
4. go to **service** tab → set **startup type** to **automatic**
5. click **install service**

or using task scheduler:

1. open task scheduler
2. create basic task
3. name: "Cloudflared Tunnel"
4. trigger: "when the computer starts"
5. action: "start a program"
   - program: `cloudflared` (or full path)
   - arguments: `tunnel run gif-cdn`
   - start in: `%USERPROFILE%\.cloudflared`
6. check "run whether user is logged on or not"
7. finish

## troubleshooting

### tunnel won't start

**docker:**

1. **check if profile is enabled:**

   ```bash
   docker compose --profile tunnel ps
   ```

2. **check logs:**

   ```bash
   docker compose --profile tunnel logs cloudflared
   ```

3. **verify config file:**
   - make sure `config/cloudflared-config.yml` exists
   - check that hostname is set (not `cdn.yourdomain.com`)
   - verify service url is `http://app:3000`

4. **check environment variable:**

   ```bash
   docker compose --profile tunnel config
   ```
   look for `TUNNEL_TOKEN` in the cloudflared service

**manual setup:**

- check that `config.yml` exists in `~/.cloudflared/` (linux/mac) or `%USERPROFILE%\.cloudflared\` (windows)
- verify the tunnel uuid is correct
- check credentials file path is correct

### common errors

**error: "unable to determine tunnel id"**

- if using token: make sure `CLOUDFLARE_TUNNEL_TOKEN` is set in `.env`
- if using credentials: make sure config file has `tunnel:` and `credentials-file:` set

**error: "failed to reach the origin service"**

- make sure the `app` service is running and healthy (docker)
- check that service url in config is `http://app:3000` (docker) or `http://localhost:3000` (manual)
- verify express server is running on port 3000

**error: "no such file or directory: /etc/cloudflared/config.yml"**

- make sure `config/cloudflared-config.yml` exists (docker)
- check file permissions

**dns not resolving**

- wait 5-10 minutes for dns propagation
- verify dns record in cloudflare dashboard
- check that proxy is enabled (orange cloud)

**502 bad gateway**

- make sure your express server is running on port 3000
- check tunnel logs for errors
- verify `service: http://localhost:3000` in config.yml (or `http://app:3000` for docker)

**can't access from internet**

- verify tunnel is running: `cloudflared tunnel list`
- check tunnel status: `cloudflared tunnel info gif-cdn`
- ensure dns record is proxied (orange cloud)

## stopping the tunnel

**docker:**

```bash
docker compose --profile tunnel down
```

or to stop just the tunnel service:

```bash
docker compose --profile tunnel stop cloudflared
```

**manual:**

press `Ctrl+C` in the terminal running the tunnel, or stop the service:

```bash
# linux
sudo systemctl stop cloudflared

# windows
# stop via services.msc or task manager
```

## making tunnel start automatically (docker)

if you want the tunnel to start automatically (remove the profile requirement), edit `docker-compose.yml` and remove the `profiles:` section from the cloudflared service:

```yaml
# remove these lines:
profiles:
  - tunnel
```

then the tunnel will start with:

```bash
docker compose up -d
```

## useful commands

```bash
# list all tunnels
cloudflared tunnel list

# get tunnel info
cloudflared tunnel info gif-cdn

# run tunnel (foreground)
cloudflared tunnel run gif-cdn

# delete tunnel (if needed)
cloudflared tunnel delete gif-cdn
```

## security notes

- ✅ cloudflare tunnel provides automatic https
- ✅ no need to open ports on your firewall
- ✅ ddos protection included
- ✅ free tier is sufficient for most use cases

## next steps

once everything is working:

1. ✅ test converting a video in discord
2. ✅ verify the gif url is accessible publicly
3. ✅ set up tunnel to run automatically on startup
4. ✅ monitor tunnel logs for any issues

