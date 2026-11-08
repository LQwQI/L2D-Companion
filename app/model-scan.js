'use strict';

/**
 * app/model-scan.js
 *
 * 通用 Live2D（Cubism 3/4/5）模型目录扫描与 manifest 合成模块（CommonJS）。
 *
 * 两个入口：
 *   scanModelDir(dir[, internalOptions]) -> ScanResult
 *   scanModelFile(filePath)              -> ScanResult
 *     filePath 可以是目录、*.model3.json 或 *.moc3。
 *
 * 扫描策略：
 *   1) 在目录内递归（深度 <= 3）查找 *.model3.json；多个时优先与文件夹同名的那个。
 *   2) 找不到 model3.json 时，用 *.moc3 与散件资源合成 manifest。
 *   3) 自动补齐 FileReferences：Moc / Textures / Physics / DisplayInfo / Pose /
 *      Expressions / Motions；Groups 保留原样（缺失时补 EyeBlink）。
 *   4) 所有 File 路径都写成相对 dir 的 POSIX 斜杠路径；引用文件必须真实存在，
 *      否则从引用中剔除并记录 warning。贴图数为 0 或 moc3 不存在时 ok:false。
 *
 * ScanResult:
 *   {
 *     ok: boolean,
 *     dir: string,               // 扫描目录的绝对路径
 *     modelFile: string|null,    // 相对 dir 的 POSIX 路径；合成时为 '__pet_generated.model3.json'
 *     virtual: boolean,          // true = manifest 与磁盘 model3 不同（被补齐/剔除）或磁盘上不存在
 *     manifest: object|null,     // 最终要提供给前端的完整 model3 JSON
 *     info: {
 *       counts: { moc, textures, physics, displayInfo, pose, expressions, motions,
 *                 motionGroups, groups, warnings },
 *       warnings: string[],
 *       moc: { file, bytes, magic, magicOk, version },
 *       ...
 *     },
 *     warnings: string[],
 *     error: string|null,
 *   }
 */

const fs = require('fs');
const path = require('path');

const MAX_SCAN_DEPTH = 3;
const GENERATED_MODEL_FILE = '__pet_generated.model3.json';

const MODEL3_FILE_RE = /\.model3\.json$/i;
const MOC3_FILE_RE = /\.moc3$/i;
const MOTION_FILE_RE = /\.motion3\.json$/i;
const EXPRESSION_FILE_RE = /\.exp3\.json$/i;
const PHYSICS_FILE_RE = /\.physics3\.json$/i;
const DISPLAY_INFO_FILE_RE = /\.cdi3\.json$/i;
const POSE_FILE_RE = /\.pose3\.json$/i;
const IMAGE_FILE_RE = /\.(png|jpe?g)$/i;
const TEXTURE_FILE_RE = /^texture_.*\.(png|jpe?g)$/i;
const IDLE_MOTION_RE = /idle|待机|呼吸|breath/i;
const KNOWN_REF_KEYS = ['Moc', 'Textures', 'Physics', 'DisplayInfo', 'Pose', 'Expressions', 'Motions'];

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

// 与对象 key 顺序无关的稳定序列化，用于判断 manifest 是否被改动。
function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      parts.push(JSON.stringify(key) + ':' + stableStringify(value[key]));
    }
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value);
}

function byRelName(a, b) {
  return compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.rel, b.rel);
}

// 去掉 Live2D 资源的规范后缀，得到“模型名/资源名”：大肥鱼.model3.json -> 大肥鱼
function assetStem(name) {
  return String(name).replace(
    /\.(model3\.json|motion3\.json|physics3\.json|cdi3\.json|pose3\.json|exp3\.json|moc3)$/i,
    ''
  );
}

function expressionStem(name) {
  return String(name).replace(/\.exp3\.json$/i, '');
}

function emptyMoc() {
  return { file: null, bytes: 0, magic: null, magicOk: false, version: null };
}

function emptyCounts() {
  return {
    moc: 0,
    textures: 0,
    physics: 0,
    displayInfo: 0,
    pose: 0,
    expressions: 0,
    motions: 0,
    motionGroups: {},
    groups: 0,
    warnings: 0,
  };
}

function newInfo(dir) {
  return {
    dir,
    ok: false,
    modelFile: null,
    virtual: false,
    moc: emptyMoc(),
    counts: emptyCounts(),
    warnings: [],
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 文件系统扫描
// ---------------------------------------------------------------------------

// 递归收集文件（广度上限制 depth）；用 realpath 防止符号链接成环。
function walkEntries(root, maxDepth) {
  const files = [];
  const seen = new Set();

  function visit(absDir, relDir, depth) {
    let real;
    try {
      real = fs.realpathSync(absDir);
    } catch (_) {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()));

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth + 1 <= maxDepth) visit(abs, rel, depth + 1);
      } else if (stat.isFile()) {
        files.push({ abs, rel, dir: relDir, depth, name: entry.name, size: stat.size });
      }
    }
  }

  visit(root, '', 0);
  return files;
}

function isTextureDirRel(relDir) {
  if (!relDir) return false;
  const segments = relDir.split('/');
  for (const segment of segments) {
    if (/\.(2048|4096)$/i.test(segment)) return true;
  }
  return false;
}

function discoverTextureFiles(files) {
  const inTextureDir = files
    .filter((f) => isTextureDirRel(f.dir) && IMAGE_FILE_RE.test(f.name))
    .sort(byRelName);
  const named = inTextureDir.filter((f) => TEXTURE_FILE_RE.test(f.name));
  if (named.length) return { files: named, fallback: false };
  if (inTextureDir.length) return { files: inTextureDir, fallback: false };
  // 兜底：模型目录根部的图片（某些简易模型直接把贴图放在根目录）
  const rootImages = files.filter((f) => f.depth === 0 && IMAGE_FILE_RE.test(f.name)).sort(byRelName);
  return { files: rootImages, fallback: rootImages.length > 0 };
}

function fileExistsAt(dir, rel) {
  const abs = path.join(dir, ...String(rel).split('/'));
  try {
    return fs.statSync(abs).isFile();
  } catch (_) {
    return false;
  }
}

// 把 manifest 里的引用规范成相对 dir 的 POSIX 路径；不合法（绝对路径/越界/空）返回 null。
function normalizeRef(ref) {
  if (typeof ref !== 'string') return null;
  let rel = ref.trim().replace(/\\/g, '/');
  if (!rel) return null;
  if (/^[a-zA-Z]:\//.test(rel) || rel.indexOf('//') === 0) return null;
  rel = rel.replace(/^(\.\/)+/, '');
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.indexOf('../') === 0 || normalized.charAt(0) === '/') return null;
  return normalized;
}

function resolveRefToExisting(dir, ref) {
  const rel = normalizeRef(ref);
  if (!rel) return null;
  return fileExistsAt(dir, rel) ? rel : null;
}

// 从候选资源中选择：优先名称主干与 hints（模型名/文件夹名/moc 名）一致的，其次层级最浅、名称排序最前。
function pickPreferred(candidates, hints) {
  if (!candidates.length) return null;
  const sorted = candidates
    .slice()
    .sort((a, b) => a.depth - b.depth || byRelName(a, b));
  const wanted = [];
  for (const hint of hints || []) {
    if (typeof hint === 'string' && hint) wanted.push(hint.toLowerCase());
  }
  for (const hint of wanted) {
    for (const file of sorted) {
      if (assetStem(file.name).toLowerCase() === hint) return file;
    }
  }
  return sorted[0];
}

// 读取 moc3 头：前 4 字节 "MOC3"，第 5 字节为版本号。
function readMoc3Header(absPath) {
  const header = emptyMoc();
  let stat = null;
  try {
    stat = fs.statSync(absPath);
  } catch (_) {
    return header;
  }
  header.bytes = stat.size;
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(5);
    const read = fs.readSync(fd, buf, 0, 5, 0);
    if (read >= 4) header.magic = buf.toString('latin1', 0, 4);
    header.magicOk = header.magic === 'MOC3';
    if (read >= 5) header.version = buf.readUInt8(4);
  } catch (e) {
    header.error = e && e.message ? e.message : String(e);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
  return header;
}

// ---------------------------------------------------------------------------
// 各 FileReferences 字段的自动补齐
// ---------------------------------------------------------------------------

function resolveAuxFile(dir, originalRefs, key, candidates, label, hints, warnings) {
  const existing = resolveRefToExisting(dir, originalRefs[key]);
  if (existing) return existing;
  if (originalRefs[key] !== undefined) {
    warnings.push(label + ' 引用不存在，已尝试自动补齐: ' + String(originalRefs[key]));
  }
  const found = pickPreferred(candidates, hints);
  return found ? found.rel : null;
}

function buildTextures(dir, originalRefs, files, warnings) {
  const textures = [];
  if (Array.isArray(originalRefs.Textures)) {
    for (const ref of originalRefs.Textures) {
      const rel = resolveRefToExisting(dir, ref);
      if (rel) textures.push(rel);
      else warnings.push('贴图缺失，已从 Textures 剔除: ' + String(ref));
    }
  } else if (originalRefs.Textures !== undefined) {
    warnings.push('Textures 字段格式无效，已按目录自动补齐');
  }

  if (!textures.length) {
    const discovered = discoverTextureFiles(files);
    for (const file of discovered.files) textures.push(file.rel);
    if (textures.length && discovered.fallback) {
      warnings.push('未发现 *.2048/*.4096 贴图目录，改用模型目录根部的图片作为贴图');
    }
  }
  return textures;
}

function buildExpressions(dir, expressionFiles, originalExpressions, warnings) {
  const list = [];
  const seen = new Set();

  if (Array.isArray(originalExpressions)) {
    for (const raw of originalExpressions) {
      if (!isPlainObject(raw)) {
        warnings.push('Expressions 含无效条目，已忽略');
        continue;
      }
      const rel = resolveRefToExisting(dir, raw.File);
      if (!rel) {
        warnings.push('表情文件缺失，已从 Expressions 剔除: ' + String(raw.File));
        continue;
      }
      const entry = Object.assign({}, raw, { File: rel });
      if (typeof entry.Name !== 'string' || !entry.Name) {
        entry.Name = expressionStem(path.posix.basename(rel));
      }
      list.push(entry);
      seen.add(rel.toLowerCase());
    }
  } else if (originalExpressions !== undefined) {
    warnings.push('Expressions 字段格式无效，已按目录自动补齐');
  }

  for (const file of expressionFiles) {
    if (seen.has(file.rel.toLowerCase())) continue;
    list.push({ Name: expressionStem(file.name), File: file.rel });
    seen.add(file.rel.toLowerCase());
  }
  return list;
}

function buildMotions(dir, motionFiles, originalMotions, warnings) {
  const groups = {};
  const referenced = new Set();

  if (isPlainObject(originalMotions)) {
    for (const groupName of Object.keys(originalMotions)) {
      const rawList = originalMotions[groupName];
      if (!Array.isArray(rawList)) {
        warnings.push('Motions.' + groupName + ' 不是数组，已忽略');
        continue;
      }
      const kept = [];
      for (const raw of rawList) {
        if (!isPlainObject(raw)) {
          warnings.push('Motions.' + groupName + ' 含无效条目，已忽略');
          continue;
        }
        const rel = resolveRefToExisting(dir, raw.File);
        if (!rel) {
          warnings.push('动作文件缺失，已从 Motions.' + groupName + ' 剔除: ' + String(raw.File));
          continue;
        }
        kept.push(Object.assign({}, raw, { File: rel }));
        referenced.add(rel.toLowerCase());
      }
      if (kept.length) {
        groups[groupName] = (groups[groupName] || []).concat(kept);
      }
    }
  } else if (originalMotions !== undefined) {
    warnings.push('Motions 字段格式无效，已按目录自动补齐');
  }

  // 未被引用的动作文件按命名归类：idle/待机/呼吸/breath -> "Idle"，其余 -> "动作"。
  for (const file of motionFiles) {
    if (referenced.has(file.rel.toLowerCase())) continue;
    const targetGroup = IDLE_MOTION_RE.test(file.name) ? 'Idle' : '动作';
    const fade = targetGroup === 'Idle' ? 1.0 : 0.4;
    if (!groups[targetGroup]) groups[targetGroup] = [];
    groups[targetGroup].push({ File: file.rel, FadeInTime: fade, FadeOutTime: fade });
    referenced.add(file.rel.toLowerCase());
  }

  // 没有任何 Idle 时，把排序第一的动作提为 Idle。
  if (!Array.isArray(groups.Idle) || groups.Idle.length === 0) {
    if (motionFiles.length) {
      const first = motionFiles[0];
      const firstLower = first.rel.toLowerCase();
      let moved = null;
      for (const groupName of Object.keys(groups)) {
        const index = groups[groupName].findIndex(function (entry) {
          return String(entry.File).toLowerCase() === firstLower;
        });
        if (index >= 0) {
          moved = groups[groupName][index];
          groups[groupName].splice(index, 1);
          if (!groups[groupName].length) delete groups[groupName];
          break;
        }
      }
      if (!moved) {
        moved = { File: first.rel, FadeInTime: 1.0, FadeOutTime: 1.0 };
      } else {
        moved = Object.assign({}, moved);
      }
      if (!groups.Idle) groups.Idle = [];
      groups.Idle.unshift(moved);
    }
  }

  // 输出时把 Idle 放到第一位，其余保持原有顺序。
  const ordered = {};
  if (Array.isArray(groups.Idle)) ordered.Idle = groups.Idle;
  for (const groupName of Object.keys(groups)) {
    if (groupName !== 'Idle') ordered[groupName] = groups[groupName];
  }
  return ordered;
}

// model3.json 候选选择：优先与文件夹同名，其次层级最浅。
function pickModel3(dir, candidates, warnings) {
  if (!candidates.length) return null;
  const dirName = path.basename(dir).toLowerCase();
  const sorted = candidates
    .slice()
    .sort((a, b) => a.depth - b.depth || byRelName(a, b));
  const exact = sorted.filter((file) => assetStem(file.name).toLowerCase() === dirName);
  if (exact.length) {
    if (exact.length > 1) {
      warnings.push('发现多个与文件夹同名的 .model3.json，使用层级最浅的: ' + exact[0].rel);
    }
    return exact[0];
  }
  if (sorted.length > 1) {
    warnings.push('发现多个 .model3.json，使用层级最浅的: ' + sorted[0].rel + '（共 ' + sorted.length + ' 个）');
  }
  return sorted[0];
}

// ---------------------------------------------------------------------------
// 主扫描流程
// ---------------------------------------------------------------------------

function buildScan(dir, options, info) {
  const warnings = info.warnings;

  const files = walkEntries(dir, MAX_SCAN_DEPTH);
  const model3Candidates = files.filter((file) => MODEL3_FILE_RE.test(file.name));

  // ---- 1. 选择磁盘上已有的 model3.json ----
  let model3Entry = null;
  let forcedModel3Rel = null;
  if (options.forcedModel3Abs) {
    const forcedAbs = options.forcedModel3Abs;
    const rel = toPosix(path.relative(dir, forcedAbs));
    if (!rel || rel.indexOf('../') === 0) {
      warnings.push('指定的模型描述文件不在目标目录内，已忽略: ' + forcedAbs);
    } else {
      forcedModel3Rel = rel;
      model3Entry = model3Candidates.find(
        (file) => file.abs.toLowerCase() === String(forcedAbs).toLowerCase()
      );
      if (!model3Entry) {
        // 可能超出递归深度，直接读取指定的文件。
        let stat = null;
        try {
          stat = fs.statSync(forcedAbs);
        } catch (_) {
          /* ignore */
        }
        if (stat && stat.isFile()) {
          model3Entry = {
            abs: forcedAbs,
            rel,
            dir: path.posix.dirname(rel),
            name: path.posix.basename(rel),
            depth: 0,
            size: stat.size,
          };
          warnings.push('指定的模型描述文件不在扫描深度内，已直接读取: ' + rel);
        } else {
          warnings.push('指定的模型描述文件不可读取: ' + rel);
        }
      }
    }
  } else {
    model3Entry = pickModel3(dir, model3Candidates, warnings);
  }

  // ---- 2. 解析已有 manifest ----
  let parsed = null;
  if (model3Entry) {
    try {
      const raw = fs.readFileSync(model3Entry.abs, 'utf8');
      const data = JSON.parse(stripBom(raw));
      if (!isPlainObject(data)) throw new Error('顶层不是 JSON 对象');
      parsed = data;
    } catch (e) {
      warnings.push(
        '模型描述文件解析失败（' +
          (forcedModel3Rel || model3Entry.rel) +
          '），改为按模型资源合成 manifest: ' +
          (e && e.message ? e.message : String(e))
      );
    }
  }
  if (parsed && parsed.FileReferences !== undefined && !isPlainObject(parsed.FileReferences)) {
    warnings.push('FileReferences 字段格式无效，已按模型资源重建');
  }
  const baseline = parsed ? deepClone(parsed) : null;
  const originalRefs = parsed && isPlainObject(parsed.FileReferences) ? parsed.FileReferences : {};
  const sourceRel = forcedModel3Rel || (model3Entry ? model3Entry.rel : null);

  // ---- 3. 收集散件资源 ----
  const moc3Files = files.filter((file) => MOC3_FILE_RE.test(file.name)).sort(byRelName);
  const motionFiles = files.filter((file) => MOTION_FILE_RE.test(file.name)).sort(byRelName);
  const expressionFiles = files.filter((file) => EXPRESSION_FILE_RE.test(file.name)).sort(byRelName);
  const physicsFiles = files.filter((file) => PHYSICS_FILE_RE.test(file.name)).sort(byRelName);
  const displayInfoFiles = files.filter((file) => DISPLAY_INFO_FILE_RE.test(file.name)).sort(byRelName);
  const poseFiles = files.filter((file) => POSE_FILE_RE.test(file.name)).sort(byRelName);

  const dirNameHint = path.basename(dir);
  const modelStemHint = sourceRel ? assetStem(path.posix.basename(sourceRel)) : '';

  // ---- 4. Moc ----
  let mocRel = null;
  if (options.forcedMocAbs) {
    const forcedAbs = options.forcedMocAbs;
    const rel = toPosix(path.relative(dir, forcedAbs));
    if (rel && rel.indexOf('../') !== 0 && fileExistsAt(dir, rel)) {
      mocRel = rel;
    } else {
      warnings.push('指定的 moc3 文件不在目标目录内或不可读取，已忽略: ' + forcedAbs);
    }
  }
  if (!mocRel) {
    mocRel = resolveRefToExisting(dir, originalRefs.Moc);
    if (!mocRel && originalRefs.Moc !== undefined) {
      warnings.push('Moc 引用不存在，已尝试自动补齐: ' + String(originalRefs.Moc));
    }
  }
  if (!mocRel) {
    const found = pickPreferred(moc3Files, [modelStemHint, dirNameHint]);
    if (found) mocRel = found.rel;
  }
  if (!mocRel) {
    return {
      ok: false,
      modelFile: sourceRel,
      virtual: false,
      manifest: null,
      error: '未找到 .moc3 文件: ' + dir,
    };
  }
  const mocStemHint = assetStem(path.posix.basename(mocRel));

  // ---- 5. Textures ----
  const textures = buildTextures(dir, originalRefs, files, warnings);
  if (!textures.length) {
    return {
      ok: false,
      modelFile: sourceRel,
      virtual: false,
      manifest: null,
      error: '未找到可用贴图（Textures 为空）: ' + dir,
    };
  }

  // ---- 6. Physics / DisplayInfo / Pose ----
  const auxHints = [modelStemHint, mocStemHint, dirNameHint];
  const physicsRel = resolveAuxFile(dir, originalRefs, 'Physics', physicsFiles, 'Physics', auxHints, warnings);
  const displayInfoRel = resolveAuxFile(dir, originalRefs, 'DisplayInfo', displayInfoFiles, 'DisplayInfo', auxHints, warnings);
  const poseRel = resolveAuxFile(dir, originalRefs, 'Pose', poseFiles, 'Pose', auxHints, warnings);

  // ---- 7. Expressions / Motions ----
  const expressions = buildExpressions(dir, expressionFiles, originalRefs.Expressions, warnings);
  const motions = buildMotions(dir, motionFiles, originalRefs.Motions, warnings);

  // ---- 8. 组装最终 manifest ----
  const refs = {};
  for (const key of Object.keys(originalRefs)) {
    if (KNOWN_REF_KEYS.indexOf(key) < 0) refs[key] = deepClone(originalRefs[key]);
  }
  refs.Moc = mocRel;
  refs.Textures = textures;
  if (physicsRel) refs.Physics = physicsRel;
  if (displayInfoRel) refs.DisplayInfo = displayInfoRel;
  if (poseRel) refs.Pose = poseRel;
  if (expressions.length) refs.Expressions = expressions;
  if (Object.keys(motions).length) refs.Motions = motions;

  let groups;
  if (parsed && Array.isArray(parsed.Groups) && parsed.Groups.length) {
    groups = deepClone(parsed.Groups);
  } else {
    if (parsed && parsed.Groups !== undefined && !Array.isArray(parsed.Groups)) {
      warnings.push('Groups 字段格式无效，已生成默认 EyeBlink 分组');
    }
    groups = [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }];
  }

  let manifest;
  if (parsed) {
    manifest = deepClone(parsed);
  } else {
    manifest = { Version: 3, FileReferences: {} };
  }
  if (!Number.isFinite(manifest.Version)) {
    manifest.Version = 3;
  } else if (manifest.Version !== 3) {
    warnings.push('manifest Version=' + manifest.Version + '，不是 Cubism 3 标准值 3');
  }
  manifest.FileReferences = refs;
  manifest.Groups = groups;

  // ---- 9. moc3 头部校验 ----
  const mocHeader = readMoc3Header(path.join(dir, ...mocRel.split('/')));
  mocHeader.file = mocRel;
  if (!mocHeader.magicOk) {
    warnings.push('moc3 头部校验失败（前 4 字节不是 "MOC3"）: ' + mocRel);
  }
  if (mocHeader.version !== null && mocHeader.version > 5) {
    warnings.push('moc3 版本 ' + mocHeader.version + ' 高于已知最高版本 5，可能无法被当前 Live2D Core 加载: ' + mocRel);
  }
  info.moc = mocHeader;

  // ---- 10. 是否改动过磁盘上的 model3 ----
  const changed = !parsed || stableStringify(manifest) !== stableStringify(baseline);
  const virtual = changed;
  const modelFile = parsed ? sourceRel : GENERATED_MODEL_FILE;

  const motionGroups = {};
  let motionTotal = 0;
  for (const groupName of Object.keys(motions)) {
    motionGroups[groupName] = motions[groupName].length;
    motionTotal += motions[groupName].length;
  }

  info.counts = {
    moc: 1,
    textures: textures.length,
    physics: physicsRel ? 1 : 0,
    displayInfo: displayInfoRel ? 1 : 0,
    pose: poseRel ? 1 : 0,
    expressions: expressions.length,
    motions: motionTotal,
    motionGroups,
    groups: groups.length,
    warnings: warnings.length,
  };
  info.source = parsed ? 'model3' : 'generated';

  return { ok: true, modelFile, virtual, manifest, error: null };
}

function runScan(dir, options) {
  const info = newInfo(dir);
  const result = {
    ok: false,
    dir,
    modelFile: null,
    virtual: false,
    manifest: null,
    info,
    warnings: info.warnings,
    error: null,
  };

  try {
    const built = buildScan(dir, options || {}, info);
    result.ok = built.ok;
    result.modelFile = built.modelFile;
    result.virtual = built.virtual;
    result.manifest = built.manifest;
    result.error = built.error || null;
  } catch (e) {
    result.error = '扫描失败: ' + (e && e.message ? e.message : String(e));
  }

  info.ok = result.ok;
  info.modelFile = result.modelFile;
  info.virtual = result.virtual;
  info.error = result.error;
  info.counts.warnings = info.warnings.length;
  return result;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 扫描目录，返回可直接交给前端的 model3 manifest。
 * @param {string} dirPath 模型目录
 * @param {object} [internalOptions] 内部选项（scanModelFile 使用：forcedModel3Abs / forcedMocAbs），外部调用可忽略
 * @returns {object} ScanResult
 */
function scanModelDir(dirPath, internalOptions) {
  const resolved = path.resolve(String(dirPath));
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    /* ignore */
  }
  if (!stat) {
    const info = newInfo(resolved);
    const message = '目录不存在或不可访问: ' + resolved;
    info.error = message;
    return { ok: false, dir: resolved, modelFile: null, virtual: false, manifest: null, info, warnings: info.warnings, error: message };
  }
  if (!stat.isDirectory()) {
    const info = newInfo(resolved);
    const message = '不是文件夹: ' + resolved;
    info.error = message;
    return { ok: false, dir: resolved, modelFile: null, virtual: false, manifest: null, info, warnings: info.warnings, error: message };
  }
  return runScan(resolved, internalOptions || {});
}

/**
 * 扫描单个文件：目录 / *.model3.json / *.moc3。
 * 对 .model3.json 会强制把该文件作为 modelFile；对 .moc3 会强制使用该 moc3。
 * @param {string} filePath
 * @returns {object} ScanResult
 */
function scanModelFile(filePath) {
  const resolved = path.resolve(String(filePath));
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    /* ignore */
  }
  if (!stat) {
    const info = newInfo(resolved);
    const message = '文件或目录不存在: ' + resolved;
    info.error = message;
    return { ok: false, dir: path.dirname(resolved), modelFile: null, virtual: false, manifest: null, info, warnings: info.warnings, error: message };
  }

  if (stat.isDirectory()) {
    return scanModelDir(resolved);
  }

  if (MODEL3_FILE_RE.test(resolved)) {
    // 内部复用 scanModelDir，并强制指定该文件作为 modelFile。
    return scanModelDir(path.dirname(resolved), { forcedModel3Abs: resolved });
  }
  if (MOC3_FILE_RE.test(resolved)) {
    // 内部复用 scanModelDir，并强制指定该 moc3。
    return scanModelDir(path.dirname(resolved), { forcedMocAbs: resolved });
  }

  const info = newInfo(path.dirname(resolved));
  const message = '不支持的文件类型（仅支持目录、*.model3.json、*.moc3）: ' + resolved;
  info.error = message;
  return {
    ok: false,
    dir: path.dirname(resolved),
    modelFile: null,
    virtual: false,
    manifest: null,
    info,
    warnings: info.warnings,
    error: message,
  };
}

module.exports = {
  scanModelDir,
  scanModelFile,
  GENERATED_MODEL_FILE,
  MAX_SCAN_DEPTH,
};
