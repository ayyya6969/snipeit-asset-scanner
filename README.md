# Snipe-IT Asset Scanner

A Progressive Web App (PWA) for performing physical asset audits with Snipe-IT. Scan QR codes on assets to verify their location matches the recorded location in Snipe-IT.

## Features

- **QR Code Scanning**: Use your phone camera to scan asset QR codes
- **Manual Entry**: Enter asset tag or SAP number manually when scanning isn't available
- **Location Verification**: Compare physical location with Snipe-IT records
- **Audit Logging**: Records sent to both Snipe-IT and local database
- **Admin Dashboard**: View all audits, export to Excel, manage records
- **Unaudited Assets View**: See assets that haven't been audited (never, this year, or overdue)
- **User Export**: Users can export their own audit history
- **PWA Support**: Install on mobile devices for quick access

## Requirements

- Node.js 18+
- Access to a Snipe-IT instance
- Snipe-IT Personal API Token with appropriate permissions

## Installation

1. Clone or download this repository

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your configuration:
   ```
   PORT=3000
   SNIPEIT_URL=https://your-snipeit-instance.com
   ADMIN_PASSWORD=your-secure-password
   ```

5. Create the database directory:
   ```bash
   mkdir db
   ```

6. Start the server:
   ```bash
   npm start
   ```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `SNIPEIT_URL` | Your Snipe-IT instance URL (no trailing slash) | - |
| `ADMIN_PASSWORD` | Password for admin dashboard | admin123 |

## Usage

### Scanner App

1. Open `http://localhost:3000` on your mobile device
2. Enter your Snipe-IT Personal API Token
3. Select your current physical location
4. Start the scanner and scan asset QR codes
   - **Or** use the "Manual Entry" button to enter an asset tag or SAP number manually
5. Review asset details and location match status
6. Add optional notes and log the audit

### Admin Dashboard

1. Open `http://localhost:3000/admin`
2. Enter the admin password
3. Enter your Snipe-IT API Token (for fetching unaudited assets)

**Audit Records Tab:**
- View all audit records
- Filter by status (match/mismatch)
- Search by asset tag, name, or location
- Delete individual records
- Export all audits to Excel

**Unaudited Assets Tab:**
- View assets never audited
- View assets not audited this year
- View assets with overdue audits
- Filter by category
- Search assets
- Export filtered list to CSV
- Data is cached for 10 minutes (use Refresh to update)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/locations` | GET | Get Snipe-IT locations |
| `/api/assets/:id` | GET | Get asset by ID |
| `/api/assets/search` | GET | Search asset by tag or SAP number |
| `/api/user` | GET | Get current user info |
| `/api/audit` | POST | Submit an audit |
| `/api/audits` | GET | Get all audits (admin) |
| `/api/audits/user/:username` | GET | Get user's audits |
| `/api/audits/export` | GET | Export audits to Excel (admin) |
| `/api/audits/export/user/:username` | GET | Export user's audits |
| `/api/snipeit/assets` | GET | Get all assets from Snipe-IT (admin) |
| `/api/audits/:id` | DELETE | Delete audit record (admin) |
| `/api/admin/verify` | POST | Verify admin password |

## Security Notes

- API tokens are stored in browser localStorage and sent via headers
- Admin password is checked server-side
- The `.env` file contains sensitive data and is excluded from git
- Ensure proper firewall rules when exposing the app

## Snipe-IT API Token

To generate a Personal API Token in Snipe-IT:

1. Log in to Snipe-IT as your user
2. Click your name in the top right
3. Select "Manage API Keys"
4. Click "Create New Token"
5. Copy the generated token

Required permissions:
- View assets
- Audit assets
- View locations

## Docker Deployment

### Using Docker Compose (Recommended)

1. Create a `.env` file with your configuration:
   ```
   SNIPEIT_URL=https://your-snipeit-instance.com
   ADMIN_PASSWORD=your-secure-password
   PORT=3000
   ```

2. Build and run:
   ```bash
   docker-compose up -d
   ```

3. Access the app at `http://localhost:3000`

### Using Docker directly

```bash
docker build -t snipeit-asset-scanner .
docker run -d \
  --name snipeit-scanner \
  -p 3000:3000 \
  -e SNIPEIT_URL=https://your-snipeit-instance.com \
  -e ADMIN_PASSWORD=your-secure-password \
  -v scanner-data:/app/db \
  snipeit-asset-scanner
```

## Exposing via Cloudflare Tunnel

If your Snipe-IT is behind NAT, you can expose this app using Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Project Structure

```
snipe-it-scan/
├── server.js           # Express server with API endpoints
├── package.json        # Node.js dependencies
├── .env                # Configuration (not in git)
├── .env.example        # Example configuration
├── .gitignore          # Git ignore rules
├── db/
│   └── audits.db       # SQLite database (created on first run)
└── public/
    ├── index.html      # Scanner PWA
    ├── admin.html      # Admin dashboard
    ├── manifest.json   # PWA manifest
    ├── sw.js           # Service worker
    └── icons/          # App icons
```

## License

ISC
