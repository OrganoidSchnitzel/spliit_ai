# Spliit AI – Unraid Installation Guide

This guide walks you through installing **Spliit AI** on an Unraid server alongside an existing [Spliit](https://github.com/spliit-app/spliit) and [Ollama](https://ollama.ai) setup.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Unraid 6.12+ | Earlier versions should also work |
| Spliit already running | Including its PostgreSQL database |
| Ollama already running | With at least one model pulled (e.g. `llama3.2`) |
| Community Applications plugin | For easy Docker container management |

> **Tip:** If Ollama is not yet installed, see [Installing Ollama on Unraid](#installing-ollama-on-unraid) at the bottom of this guide.

---

## Step 1 – Find your Spliit network and database details

You need to know:

1. **The Docker network** Spliit uses so Spliit AI can reach the database.
2. **PostgreSQL credentials** that Spliit's database uses.

### 1a. Find the network name

In the Unraid web UI, go to **Docker → Network** (or run the command below in the Unraid terminal):

```bash
docker network ls
```

Look for the network that contains your Spliit containers (typically something like `spliit_default` or `br0`).

```bash
# Show which containers are on which network
docker inspect --format '{{.Name}} → {{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' \
  $(docker ps -q)
```

Note down the network name – you will enter it in Step 3.

### 1b. Find the PostgreSQL host and credentials

The PostgreSQL container name (e.g. `spliit-db`) is what Spliit AI will use as `DB_HOST`.

```bash
# List running containers and their names
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

If Spliit was set up via a `docker-compose.yml`, open that file and note:

- `POSTGRES_DB` (usually `spliit`)
- `POSTGRES_USER` (usually `postgres`)
- `POSTGRES_PASSWORD`

---

## Step 2 – Build the Spliit AI Docker image

Unraid does not have a pre-built image in Docker Hub yet, so you build it locally.

1. Open an **Unraid terminal** (Tools → Terminal in the web UI or SSH in).

2. Choose a folder for the project, e.g. `/mnt/user/appdata/spliit-ai`:

```bash
mkdir -p /mnt/user/appdata/spliit-ai
cd /mnt/user/appdata/spliit-ai
```

3. Download the repository files (requires internet access from Unraid):

```bash
# Using curl to download a zip of the repo
curl -L https://github.com/OrganoidSchnitzel/spliit_ai/archive/refs/heads/main.zip \
  -o spliit_ai.zip
unzip spliit_ai.zip
mv spliit_ai-main/* .
rm -rf spliit_ai-main spliit_ai.zip
```

4. Build the Docker image:

```bash
docker build -t spliit-ai:latest .
```

This takes 1–3 minutes on a typical Unraid system.

---

## Step 3 – Create the environment file

Copy the example config and fill in your values:

```bash
cp .env.example .env
vi .env      # or: nano .env
```

Edit the following values (everything else can stay at its default):

```dotenv
# ── PostgreSQL (Spliit's database) ───────────────────────────────────────────
DB_HOST=spliit-db          # container name of the Spliit PostgreSQL container
DB_PORT=5432
DB_NAME=spliit
DB_USER=postgres
DB_PASSWORD=your_db_password_here

# ── Ollama ───────────────────────────────────────────────────────────────────
OLLAMA_BASE_URL=http://ollama:11434   # container name of your Ollama container
OLLAMA_MODEL=llama3.2                 # model you have pulled

# ── Behaviour ────────────────────────────────────────────────────────────────
CONFIDENCE_THRESHOLD=0.6   # 0–1, lower = auto-apply more, higher = more manual review
SCHEDULER_ENABLED=true
SCHEDULER_CRON=*/15 * * * *   # every 15 minutes
BATCH_SIZE=10
```

> **Security note:** This service is intended for personal, local use only.  
> Do **not** expose port 3000 to the internet.

---

## Step 4 – Run the container

Use the same Docker network as Spliit so all containers can reach each other by name.

Replace `spliit_default` with your actual network name from Step 1a.

```bash
docker run -d \
  --name spliit-ai \
  --network spliit_default \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/user/appdata/spliit-ai/data:/app/data \
  --env-file /mnt/user/appdata/spliit-ai/.env \
  spliit-ai:latest
```

> The `-v` flag mounts a persistent volume so the processing history database (`data/history.db`) survives container restarts.

Check the logs to confirm everything started correctly:

```bash
docker logs -f spliit-ai
```

You should see output similar to:

```
[DB] Connected to PostgreSQL
[Ollama] Health check OK – model: llama3.2
[Scheduler] Job scheduled – cron: */15 * * * *
Spliit AI listening on port 3000
```

---

## Step 5 – Open the web UI

In your browser, navigate to:

```
http://<your-unraid-ip>:3000
```

You will see the **Dashboard** with:
- Database connection status
- Ollama connection status + active model
- Scheduler status
- List of uncategorized Spliit expenses

---

## Step 6 – Add the container to the Unraid Docker UI (optional)

To manage the container through the Unraid web interface (start/stop, auto-start, etc.):

1. Go to **Docker** in the Unraid web UI.
2. Click **Add Container**.
3. Fill in:
   - **Name:** `spliit-ai`
   - **Repository:** `spliit-ai:latest` (the local image you built)
   - **Network Type:** choose your Spliit network
   - **Port Mappings:** Host `3000` → Container `3000` (TCP)
   - **Volume Mappings:** Host `/mnt/user/appdata/spliit-ai/data` → Container `/app/data`
   - **Environment Variables:** paste from your `.env` file, one per line
4. Click **Apply**.

Unraid will now manage the container lifecycle (auto-start on boot, visible in the Docker panel).

---

## Updating Spliit AI

When a new version is released:

```bash
cd /mnt/user/appdata/spliit-ai

# Pull the latest code
curl -L https://github.com/OrganoidSchnitzel/spliit_ai/archive/refs/heads/main.zip \
  -o spliit_ai.zip
unzip -o spliit_ai.zip
mv spliit_ai-main/* .
rm -rf spliit_ai-main spliit_ai.zip

# Rebuild and restart
docker build -t spliit-ai:latest .
docker stop spliit-ai && docker rm spliit-ai

# Re-run with the same command as Step 4
docker run -d \
  --name spliit-ai \
  --network spliit_default \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/user/appdata/spliit-ai/data:/app/data \
  --env-file /mnt/user/appdata/spliit-ai/.env \
  spliit-ai:latest
```

---

## Troubleshooting

### "Cannot connect to database"

- Check `DB_HOST` matches the exact container name of the PostgreSQL container:
  ```bash
  docker ps --format '{{.Names}}'
  ```
- Ensure both containers are on the same Docker network:
  ```bash
  docker network inspect spliit_default
  ```

### "Ollama unreachable"

- Verify Ollama is running:
  ```bash
  docker ps | grep ollama
  ```
- Check that `OLLAMA_BASE_URL` uses the Ollama container name, not `localhost`:
  ```dotenv
  OLLAMA_BASE_URL=http://ollama:11434
  ```
- Check the Ollama container is on the same network as Spliit AI.

### "No models available" / model name mismatch

- List models pulled in Ollama:
  ```bash
  docker exec ollama ollama list
  ```
- Update `OLLAMA_MODEL` in `.env` to exactly match one of the listed names.
- Pull a model if needed:
  ```bash
  docker exec ollama ollama pull llama3.2
  ```

### Viewing logs

```bash
docker logs spliit-ai        # last few lines
docker logs -f spliit-ai     # follow in real time
docker logs --tail 100 spliit-ai
```

---

## Installing Ollama on Unraid

If you do not yet have Ollama running on Unraid:

1. In the Unraid web UI go to **Apps** (Community Applications).
2. Search for **Ollama**.
3. Click **Install** on the Ollama template. Accept the defaults or adjust the port/data path.
4. After Ollama starts, pull a model from the Unraid terminal:
   ```bash
   docker exec ollama ollama pull llama3.2
   ```
5. Verify Ollama is responding:
   ```bash
   curl http://localhost:11434/api/tags
   ```

> **GPU acceleration:** If your Unraid server has an NVIDIA GPU, enable the NVIDIA plugin in Unraid and make sure the Ollama Docker template has the GPU passthrough option checked. This will significantly speed up LLM inference.

---

## Recommended models

| Model | Size | Quality | Notes |
|-------|------|---------|-------|
| `llama3.2` | ~2 GB | ★★★★☆ | Good default, fast on CPU |
| `llama3.2:1b` | ~900 MB | ★★★☆☆ | Smallest footprint, still usable |
| `mistral` | ~4 GB | ★★★★★ | Better quality, needs more RAM |
| `qwen2.5:3b` | ~2 GB | ★★★★☆ | Efficient, good multilingual |

Pull any of these with:

```bash
docker exec ollama ollama pull <model-name>
```

Then update `OLLAMA_MODEL` in your `.env` and restart Spliit AI.
