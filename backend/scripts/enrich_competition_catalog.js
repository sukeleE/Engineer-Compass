// 竞赛数据增强：精确日期回填、三级知识点扩展、真实学习资源映射。
// 用法：node scripts/enrich_competition_catalog.js --apply
// 特性：幂等；不会删除人工数据；找不到资源的知识点保持空缺。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/database.js';

const APPLY = process.argv.includes('--apply');
const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'catalog', 'competition-knowledge-catalog.json'), 'utf8')
);

const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

function firstExactDate(text, fallbackYear) {
  const source = String(text || '');
  const full = source.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (full) {
    return {
      start: `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')}`,
      end: '',
    };
  }
  const iso = source.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { start: iso[0], end: '' };
  const monthDay = source.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDay && fallbackYear) {
    return {
      start: `${fallbackYear}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`,
      end: '',
    };
  }
  return null;
}

function exactDateRange(text, fallbackYear) {
  const source = String(text || '');
  const range = source.match(
    /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[-—–至~]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/
  );
  if (range) {
    const year = Number(range[1]) || fallbackYear;
    if (!year) return null;
    const startMonth = Number(range[2]);
    const endMonth = Number(range[4]) || startMonth;
    return {
      start: `${year}-${String(startMonth).padStart(2, '0')}-${String(range[3]).padStart(2, '0')}`,
      end: `${year}-${String(endMonth).padStart(2, '0')}-${String(range[5]).padStart(2, '0')}`,
    };
  }
  return firstExactDate(source, fallbackYear);
}

function hasMonth(text) {
  return /\d{1,2}\s*月/.test(String(text || ''));
}

function inferDates(comp) {
  const year = Number(comp.data_year) || Number(String(comp.timeline_raw || '').match(/(20\d{2})/)?.[1]) || null;
  const signStart = exactDateRange(comp.sign_start, year);
  const signEnd = exactDateRange(comp.sign_end, year);
  const competitionRange = exactDateRange(comp.national_time, year)
    || exactDateRange(comp.province_time, year)
    || exactDateRange(comp.timeline_raw, year);
  const values = {
    registration_start_date: signStart?.start || null,
    registration_deadline: signEnd?.start || null,
    competition_start_date: competitionRange?.start || null,
    competition_end_date: competitionRange?.end || null,
  };
  const count = Object.values(values).filter(Boolean).length;
  values.date_status = count >= 3 ? 'exact' : count > 0 ? 'partial'
    : [comp.sign_start, comp.sign_end, comp.province_time, comp.national_time, comp.timeline_raw].some(hasMonth)
      ? 'month_only' : 'unknown';
  values.date_source_url = comp.date_source_url || comp.official_url || comp.source_url || null;
  return values;
}

function expansionFor(node) {
  const context = normalize(`${node.node_name} ${node.node_desc || ''} ${node.keywords || ''}`);
  const hit = catalog.expansions.find((entry) => entry.match.some((keyword) => context.includes(normalize(keyword))));
  if (hit) return hit.children;
  return ['基础概念', '实践方法', '项目应用'].map((suffix) => `${node.node_name}${suffix}`);
}

function resourceMatches(context) {
  const text = normalize(context);
  const seen = new Set();
  const out = [];
  for (const group of catalog.resources) {
    if (!group.match.some((keyword) => text.includes(normalize(keyword)))) continue;
    for (const item of group.items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

const stats = {
  datesUpdated: 0,
  nodesAdded: 0,
  resourcesAdded: 0,
  nodesWithResources: 0,
  missingResources: 0,
};

if (APPLY) db.exec('BEGIN');
try {
  const competitions = db.prepare("SELECT * FROM competition WHERE status = 'active' ORDER BY id").all();
  const updateDates = db.prepare(`
    UPDATE competition SET
      registration_start_date = COALESCE(NULLIF(registration_start_date, ''), ?),
      registration_deadline = COALESCE(NULLIF(registration_deadline, ''), ?),
      competition_start_date = COALESCE(NULLIF(competition_start_date, ''), ?),
      competition_end_date = COALESCE(NULLIF(competition_end_date, ''), ?),
      date_status = CASE
        WHEN date_status IS NULL OR date_status IN ('', 'unknown') THEN ?
        ELSE date_status
      END,
      date_source_url = COALESCE(NULLIF(date_source_url, ''), ?),
      date_updated_at = CASE
        WHEN registration_start_date IS NULL OR registration_start_date = '' OR date_updated_at IS NULL
        THEN CURRENT_TIMESTAMP ELSE date_updated_at
      END
    WHERE id = ?
  `);
  for (const comp of competitions) {
    const dates = inferDates(comp);
    if (APPLY) {
      const result = updateDates.run(
        dates.registration_start_date,
        dates.registration_deadline,
        dates.competition_start_date,
        dates.competition_end_date,
        dates.date_status,
        dates.date_source_url,
        comp.id,
      );
      if (result.changes) stats.datesUpdated += 1;
    } else if (Object.values(dates).some((value) => value && value !== 'unknown')) {
      stats.datesUpdated += 1;
    }
  }

  const allNodes = db.prepare('SELECT * FROM tech_stack ORDER BY comp_id, process_id, id').all();
  const childrenByParent = new Map();
  for (const node of allNodes) {
    const key = `${node.process_id}:${Number(node.parent_id) || 0}`;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  const insertNode = db.prepare(`
    INSERT INTO tech_stack
    (comp_id, process_id, parent_id, node_name, node_desc, level, keywords, sort_order)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const queue = allNodes.filter((node) => Number(node.level || 1) < 3);
  while (queue.length) {
    const node = queue.shift();
    const key = `${node.process_id}:${node.id}`;
    if ((childrenByParent.get(key) || []).length) continue;
    const names = expansionFor(node);
    const inheritedKeywords = [node.keywords, node.node_name].filter(Boolean).join(' ');
    names.forEach((name, index) => {
      const child = {
        comp_id: node.comp_id,
        process_id: node.process_id,
        parent_id: node.id,
        node_name: name,
        node_desc: `由「${node.node_name}」自动细分，可人工继续修改`,
        level: Number(node.level || 1) + 1,
        keywords: inheritedKeywords,
        sort_order: index + 1,
      };
      if (APPLY) {
        const result = insertNode.run(
          child.comp_id,
          child.process_id,
          child.parent_id,
          child.node_name,
          child.node_desc,
          child.level,
          child.keywords,
          child.sort_order,
        );
        child.id = Number(result.lastInsertRowid);
        if (!childrenByParent.has(key)) childrenByParent.set(key, []);
        childrenByParent.get(key).push(child);
        if (child.level < 3) queue.push(child);
      }
      stats.nodesAdded += 1;
    });
  }

  const freshNodes = APPLY
    ? db.prepare('SELECT * FROM tech_stack ORDER BY comp_id, process_id, id').all()
    : allNodes;
  const byId = new Map(freshNodes.map((node) => [node.id, node]));
  const existingResources = new Set(
    db.prepare("SELECT tech_node_id, url FROM media_resource WHERE tech_node_id IS NOT NULL AND source_type != 'search'")
      .all()
      .map((row) => `${row.tech_node_id}|${row.url}`)
  );
  const insertResource = db.prepare(`
    INSERT INTO media_resource
    (comp_id, category, platform, title, keyword, url, tech_node_id, source_type,
     resource_type, provider, verified_at)
    VALUES (?, 'knowledge', ?, ?, ?, ?, ?, 'manual', ?, ?, CURRENT_TIMESTAMP)
  `);

  for (const node of freshNodes) {
    const names = [];
    let cursor = node;
    let guard = 0;
    while (cursor && guard < 8) {
      names.unshift(cursor.node_name);
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
      guard += 1;
    }
    const matches = resourceMatches(`${names.join(' ')} ${node.node_desc || ''} ${node.keywords || ''}`);
    if (!matches.length) {
      stats.missingResources += 1;
      continue;
    }
    stats.nodesWithResources += 1;
    for (const item of matches) {
      const dedupeKey = `${node.id}|${item.url}`;
      if (existingResources.has(dedupeKey)) continue;
      existingResources.add(dedupeKey);
      if (APPLY) {
        insertResource.run(
          node.comp_id,
          item.platform || 'docs',
          item.title,
          node.node_name,
          item.url,
          node.id,
          item.resource_type || 'article',
          item.provider || '',
        );
      }
      stats.resourcesAdded += 1;
    }
  }

  if (APPLY) db.exec('COMMIT');
  console.log(JSON.stringify({ applied: APPLY, ...stats }, null, 2));
} catch (error) {
  if (APPLY) db.exec('ROLLBACK');
  console.error(error);
  process.exit(1);
}
