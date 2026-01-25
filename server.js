require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Snipe-IT configuration - update this to your Snipe-IT URL
const SNIPEIT_URL = process.env.SNIPEIT_URL || 'http://localhost:8080';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Asset cache (stores processed assets for 10 minutes)
const assetCache = {
  data: null,
  timestamp: null,
  ttl: 10 * 60 * 1000 // 10 minutes
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'db', 'audits.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    asset_tag TEXT NOT NULL,
    asset_name TEXT,
    expected_location_id INTEGER,
    expected_location_name TEXT,
    actual_location_id INTEGER NOT NULL,
    actual_location_name TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT,
    user_name TEXT,
    snipeit_audit_posted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT
  )
`);

// Add resolved columns if they don't exist (for existing databases)
try {
  db.exec(`ALTER TABLE audits ADD COLUMN resolved_at DATETIME`);
} catch (e) { /* Column already exists */ }
try {
  db.exec(`ALTER TABLE audits ADD COLUMN resolved_by TEXT`);
} catch (e) { /* Column already exists */ }
try {
  db.exec(`ALTER TABLE audits ADD COLUMN sap_asset_number TEXT`);
} catch (e) { /* Column already exists */ }

// API Routes

// Get Snipe-IT locations
app.get('/api/locations', async (req, res) => {
  const apiToken = req.headers['x-api-token'];

  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  try {
    const response = await axios.get(`${SNIPEIT_URL}/api/v1/locations`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    // Return only top-level locations (parent_id is null)
    const locations = response.data.rows.filter(loc => !loc.parent_id);
    res.json(locations);
  } catch (error) {
    console.error('Error fetching locations:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch locations',
      details: error.response?.data || error.message
    });
  }
});

// Search asset by asset tag or SAP number (for manual entry)
app.get('/api/assets/search', async (req, res) => {
  const apiToken = req.headers['x-api-token'];
  const { query } = req.query;

  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Search query required' });
  }

  const searchTerm = query.trim();

  try {
    // First, try searching by asset tag (exact match)
    const tagResponse = await axios.get(`${SNIPEIT_URL}/api/v1/hardware/bytag/${encodeURIComponent(searchTerm)}`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    // If found by tag, return it
    if (tagResponse.data && tagResponse.data.id) {
      return res.json(tagResponse.data);
    }
  } catch (error) {
    // Asset not found by tag, continue to search
    console.log('Asset not found by tag, searching by SAP number...');
  }

  try {
    // Search all assets and filter by SAP number
    const searchResponse = await axios.get(`${SNIPEIT_URL}/api/v1/hardware`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      params: {
        search: searchTerm,
        limit: 50
      }
    });

    const assets = searchResponse.data.rows || [];

    // First check if any asset tag matches exactly
    const exactTagMatch = assets.find(a =>
      a.asset_tag && a.asset_tag.toLowerCase() === searchTerm.toLowerCase()
    );
    if (exactTagMatch) {
      return res.json(exactTagMatch);
    }

    // Search for SAP asset number match in custom fields
    for (const asset of assets) {
      if (asset.custom_fields) {
        // Try exact field name match first
        const sapField = asset.custom_fields['SAP Asset Number / ID'] ||
                         asset.custom_fields['SAP Asset Number'];

        if (sapField && sapField.value && sapField.value.toLowerCase() === searchTerm.toLowerCase()) {
          return res.json(asset);
        }

        // Search through all custom fields for SAP-related field
        for (const [fieldName, fieldData] of Object.entries(asset.custom_fields)) {
          if ((fieldName.toLowerCase().includes('sap') ||
               (fieldData && fieldData.field && fieldData.field.toLowerCase().includes('sap'))) &&
              fieldData && fieldData.value && fieldData.value.toLowerCase() === searchTerm.toLowerCase()) {
            return res.json(asset);
          }
        }
      }
    }

    // If still not found, return 404
    return res.status(404).json({ error: 'Asset not found. Please check the asset tag or SAP number.' });

  } catch (error) {
    console.error('Error searching asset:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to search asset',
      details: error.response?.data || error.message
    });
  }
});

// Get asset by ID (extracted from QR URL)
app.get('/api/assets/:id', async (req, res) => {
  const apiToken = req.headers['x-api-token'];
  const { id } = req.params;

  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  try {
    const response = await axios.get(`${SNIPEIT_URL}/api/v1/hardware/${id}`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching asset:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch asset',
      details: error.response?.data || error.message
    });
  }
});

// Get current user info
app.get('/api/user', async (req, res) => {
  const apiToken = req.headers['x-api-token'];

  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  try {
    const response = await axios.get(`${SNIPEIT_URL}/api/v1/users/me`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching user:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch user',
      details: error.response?.data || error.message
    });
  }
});

// Post audit to Snipe-IT and save locally
app.post('/api/audit', async (req, res) => {
  const apiToken = req.headers['x-api-token'];
  const {
    asset_id,
    asset_tag,
    asset_name,
    sap_asset_number,
    expected_location_id,
    expected_location_name,
    actual_location_id,
    actual_location_name,
    notes,
    user_name
  } = req.body;

  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  // Determine status
  const status = expected_location_id === actual_location_id ? 'match' : 'mismatch';

  let snipeitAuditPosted = 0;

  // Post audit to Snipe-IT
  try {
    await axios.post(`${SNIPEIT_URL}/api/v1/hardware/audit`, {
      asset_tag: asset_tag,
      location_id: actual_location_id,
      note: notes || `Audit performed. Status: ${status}. Expected: ${expected_location_name}, Found at: ${actual_location_name}`
    }, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    snipeitAuditPosted = 1;
  } catch (error) {
    console.error('Error posting audit to Snipe-IT:', error.response?.data || error.message);
    // Continue to save locally even if Snipe-IT fails
  }

  // Save to local database
  try {
    const stmt = db.prepare(`
      INSERT INTO audits (
        asset_id, asset_tag, asset_name, sap_asset_number,
        expected_location_id, expected_location_name,
        actual_location_id, actual_location_name,
        status, notes, user_name, snipeit_audit_posted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      asset_id, asset_tag, asset_name, sap_asset_number || null,
      expected_location_id, expected_location_name,
      actual_location_id, actual_location_name,
      status, notes, user_name, snipeitAuditPosted
    );

    res.json({
      success: true,
      id: result.lastInsertRowid,
      status,
      snipeit_audit_posted: snipeitAuditPosted === 1
    });
  } catch (error) {
    console.error('Error saving audit:', error.message);
    res.status(500).json({ error: 'Failed to save audit' });
  }
});

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Get all audits (for admin dashboard)
app.get('/api/audits', (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  try {
    const stmt = db.prepare('SELECT * FROM audits ORDER BY created_at DESC');
    const audits = stmt.all();
    res.json(audits);
  } catch (error) {
    console.error('Error fetching audits:', error.message);
    res.status(500).json({ error: 'Failed to fetch audits' });
  }
});

// Get audits for a specific user (for user export)
app.get('/api/audits/user/:username', (req, res) => {
  const { username } = req.params;
  try {
    const stmt = db.prepare('SELECT * FROM audits WHERE user_name = ? ORDER BY created_at DESC');
    const audits = stmt.all(username);
    res.json(audits);
  } catch (error) {
    console.error('Error fetching user audits:', error.message);
    res.status(500).json({ error: 'Failed to fetch user audits' });
  }
});

// Export audits to Excel (admin - all audits)
app.get('/api/audits/export', (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  try {
    const stmt = db.prepare('SELECT * FROM audits ORDER BY created_at DESC');
    const audits = stmt.all();

    // Transform data for Excel
    const exportData = audits.map(audit => ({
      'ID': audit.id,
      'Asset Tag': audit.asset_tag,
      'Asset Name': audit.asset_name,
      'SAP Asset Number': audit.sap_asset_number || '',
      'Expected Location': audit.expected_location_name,
      'Actual Location': audit.actual_location_name,
      'Status': audit.status.toUpperCase(),
      'Notes': audit.notes,
      'Audited By': audit.user_name,
      'Posted to Snipe-IT': audit.snipeit_audit_posted ? 'Yes' : 'No',
      'Date': audit.created_at
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audits');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename=audit_report.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting audits:', error.message);
    res.status(500).json({ error: 'Failed to export audits' });
  }
});

// Export audits for specific user (user export)
app.get('/api/audits/export/user/:username', (req, res) => {
  const { username } = req.params;
  try {
    const stmt = db.prepare('SELECT * FROM audits WHERE user_name = ? ORDER BY created_at DESC');
    const audits = stmt.all(username);

    // Transform data for Excel
    const exportData = audits.map(audit => ({
      'ID': audit.id,
      'Asset Tag': audit.asset_tag,
      'Asset Name': audit.asset_name,
      'SAP Asset Number': audit.sap_asset_number || '',
      'Expected Location': audit.expected_location_name,
      'Actual Location': audit.actual_location_name,
      'Status': audit.status.toUpperCase(),
      'Notes': audit.notes,
      'Date': audit.created_at
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'My Audits');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename=my_audits_${username}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting user audits:', error.message);
    res.status(500).json({ error: 'Failed to export user audits' });
  }
});

// Get all assets from Snipe-IT with audit info (admin only)
app.get('/api/snipeit/assets', async (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  const apiToken = req.headers['x-api-token'];
  const forceRefresh = req.query.refresh === 'true';

  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  if (!apiToken) {
    return res.status(401).json({ error: 'Snipe-IT API token required' });
  }

  // Check cache first (unless force refresh requested)
  const now = Date.now();
  if (!forceRefresh && assetCache.data && assetCache.timestamp && (now - assetCache.timestamp) < assetCache.ttl) {
    console.log('Returning cached assets data');
    return res.json({
      ...assetCache.data,
      cached: true,
      cache_age: Math.round((now - assetCache.timestamp) / 1000)
    });
  }

  try {
    console.log('Fetching fresh assets from Snipe-IT...');

    // Fetch all assets from Snipe-IT with pagination
    let allAssets = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(`${SNIPEIT_URL}/api/v1/hardware`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          limit: limit,
          offset: offset,
          sort: 'asset_tag',
          order: 'asc'
        }
      });

      const assets = response.data.rows || [];
      allAssets = allAssets.concat(assets);
      console.log(`Fetched ${allAssets.length} of ${response.data.total} assets...`);

      if (assets.length < limit || allAssets.length >= response.data.total) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    // Helper to extract date from Snipe-IT format (can be string or { datetime, formatted })
    const extractDate = (dateField) => {
      if (!dateField) return null;
      if (typeof dateField === 'string') return dateField;
      if (typeof dateField === 'object' && dateField.datetime) return dateField.datetime;
      if (typeof dateField === 'object' && dateField.formatted) return dateField.formatted;
      return null;
    };

    const parseDate = (dateField) => {
      const dateStr = extractDate(dateField);
      if (!dateStr) return null;
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : date;
    };

    // Process assets to extract audit info
    const currentYear = new Date().getFullYear();
    const currentYearStart = new Date(currentYear, 0, 1);

    const processedAssets = allAssets.map(asset => {
      const lastAuditDate = parseDate(asset.last_audit_date);
      const nextAuditDate = parseDate(asset.next_audit_date);

      // Extract SAP Asset Number from custom fields (field #17)
      let sapAssetNumber = null;
      if (asset.custom_fields && Object.keys(asset.custom_fields).length > 0) {
        // Try exact field name match first
        const sapField = asset.custom_fields['SAP Asset Number / ID'] ||
                         asset.custom_fields['SAP Asset Number'];

        if (sapField) {
          sapAssetNumber = sapField.value || null;
        } else {
          // Search through all custom fields for SAP-related field
          for (const [fieldName, fieldData] of Object.entries(asset.custom_fields)) {
            if (fieldName.toLowerCase().includes('sap') ||
                (fieldData && fieldData.field && fieldData.field.toLowerCase().includes('sap'))) {
              sapAssetNumber = fieldData.value || null;
              break;
            }
          }
        }
      }

      return {
        id: asset.id,
        asset_tag: asset.asset_tag,
        name: asset.name,
        serial: asset.serial,
        model: asset.model?.name || null,
        category: asset.category?.name || null,
        location: asset.location?.name || null,
        location_id: asset.location?.id || null,
        assigned_to: asset.assigned_to?.name || null,
        status: asset.status_label?.name || null,
        sap_asset_number: sapAssetNumber,
        last_audit_date: extractDate(asset.last_audit_date),
        next_audit_date: extractDate(asset.next_audit_date),
        never_audited: !asset.last_audit_date,
        not_audited_this_year: lastAuditDate ? lastAuditDate < currentYearStart : true,
        audit_overdue: nextAuditDate ? nextAuditDate < new Date() : false
      };
    });

    // Separate into categories
    const neverAudited = processedAssets.filter(a => a.never_audited);
    const notAuditedThisYear = processedAssets.filter(a => !a.never_audited && a.not_audited_this_year);
    const auditOverdue = processedAssets.filter(a => a.audit_overdue);

    const result = {
      total: allAssets.length,
      never_audited: neverAudited,
      not_audited_this_year: notAuditedThisYear,
      audit_overdue: auditOverdue,
      all_assets: processedAssets
    };

    // Store in cache
    assetCache.data = result;
    assetCache.timestamp = now;
    console.log(`Cached ${allAssets.length} assets`);

    res.json({
      ...result,
      cached: false,
      cache_age: 0
    });
  } catch (error) {
    console.error('Error fetching assets from Snipe-IT:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch assets from Snipe-IT',
      details: error.response?.data || error.message
    });
  }
});

// Update asset location in Snipe-IT (admin only)
app.patch('/api/assets/:id/location', async (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  const apiToken = req.headers['x-api-token'];
  const { location_id } = req.body;
  const { id } = req.params;

  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  if (!apiToken) {
    return res.status(401).json({ error: 'Snipe-IT API token required' });
  }

  if (!location_id) {
    return res.status(400).json({ error: 'location_id is required' });
  }

  try {
    const response = await axios.patch(`${SNIPEIT_URL}/api/v1/hardware/${id}`, {
      rtd_location_id: location_id
    }, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json({ success: true, asset: response.data });
  } catch (error) {
    console.error('Error updating asset location:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to update asset location',
      details: error.response?.data || error.message
    });
  }
});

// Resolve mismatch audits (update location in Snipe-IT and mark as resolved)
app.post('/api/audits/resolve', async (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  const apiToken = req.headers['x-api-token'];
  const { audit_ids, resolved_by } = req.body;

  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  if (!apiToken) {
    return res.status(401).json({ error: 'Snipe-IT API token required' });
  }

  if (!audit_ids || !Array.isArray(audit_ids) || audit_ids.length === 0) {
    return res.status(400).json({ error: 'audit_ids array is required' });
  }

  const results = [];
  const errors = [];

  for (const auditId of audit_ids) {
    try {
      // Get the audit record
      const audit = db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId);

      if (!audit) {
        errors.push({ id: auditId, error: 'Audit not found' });
        continue;
      }

      if (audit.status !== 'mismatch') {
        errors.push({ id: auditId, error: 'Audit is not a mismatch' });
        continue;
      }

      if (audit.resolved_at) {
        errors.push({ id: auditId, error: 'Already resolved' });
        continue;
      }

      // Update asset location in Snipe-IT
      await axios.patch(`${SNIPEIT_URL}/api/v1/hardware/${audit.asset_id}`, {
        rtd_location_id: audit.actual_location_id
      }, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      // Mark audit as resolved in local DB
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE audits
        SET status = 'resolved', resolved_at = ?, resolved_by = ?
        WHERE id = ?
      `).run(now, resolved_by || 'Admin', auditId);

      results.push({ id: auditId, success: true });
    } catch (error) {
      console.error(`Error resolving audit ${auditId}:`, error.response?.data || error.message);
      errors.push({
        id: auditId,
        error: error.response?.data?.messages || error.message
      });
    }
  }

  res.json({
    success: errors.length === 0,
    resolved: results.length,
    failed: errors.length,
    results,
    errors
  });
});

// Delete audit record (admin only)
app.delete('/api/audits/:id', (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password required' });
  }

  try {
    const stmt = db.prepare('DELETE FROM audits WHERE id = ?');
    stmt.run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting audit:', error.message);
    res.status(500).json({ error: 'Failed to delete audit' });
  }
});

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Snipe-IT Scan server running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
  console.log(`Snipe-IT URL: ${SNIPEIT_URL}`);
});
