//! 读豆包（Electron / Chromium）的磁盘缓存，给会话页里的图片位置找真实图片字节（只读）。
//!
//! UIA 拿不到图片 URL / 字节（`doubao_ui.rs` 只能给出「这里有一张 W×H 的图」），
//! 但图片本身在 Chromium 的 blockfile 缓存里：
//!
//! - 目录 `%LOCALAPPDATA%\Doubao\User Data\Profile 2\Cache\Cache_Data`（也可能是 `Default`）；
//! - `data_1`（256 字节块）里是 EntryStore：key（带分区前缀的 URL）、4 个数据流的地址；
//!   长 key 在 `data_2` / `data_3`；大正文（图片）在外部文件 `f_XXXXXX`，内容就是裸的图片字节；
//! - 豆包运行时这些文件被锁，必须「共享读」（`FILE_SHARE_READ|WRITE|DELETE`）；
//! - 全程只读：不写、不删缓存目录里的任何文件。
//!
//! 匹配策略（按版面对缓存，**不是**按内容对）：
//! 1. 只认三类对话图：`rc_gen_image/`（生成图）、`labis/image/`、`isp-i18n-media/image/`（搜索配图）；
//!    头像等界面图（`tos-cn-i-a9rns2rl98/<hash>.png`）每次重载都会再加载，会污染分批，直接排除；
//! 2. 同一 hash = 一张图的多个尺寸变体；该图的「首次加载点」= 变体里最小的 `f_` 编号；
//! 3. 同一条消息的图是连续加载的：按首次加载点排序，相邻两张相隔 > 10 秒就切一批；
//! 4. 从最后一条有图的消息往前、同时从最新一批往前，找「图数恰好相等」的批一一对应。
//!
//! **未验证的风险**：同一批内图的先后顺序（缓存按网络完成顺序，窗口按版面顺序）可能不一致，
//! 本方案按首次加载顺序对应——组内可能错位，但不会串到别的消息。对不上的位置一律返回 `None`（前端显示占位）。

use base64::Engine;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`
const SHARE_ALL: u32 = 7;
/// 块文件头
const BLOCK_HEADER: u64 = 8192;
const ENTRY_SIZE: usize = 256;
/// 内联 key 的上限：一个 entry 最多占 4 个 256 字节块，前 96 字节是 EntryStore 头
const MAX_INLINE_KEY: usize = 4 * ENTRY_SIZE - 96 - 1;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// 相邻两张图首次加载相隔超过这个时间，就算两批
const BATCH_GAP: Duration = Duration::from_secs(10);
const HEAD_FAST: usize = 64 * 1024;
const HEAD_MAX: usize = 200 * 1024;
/// 目录选择结果的复用时间（前端 3 秒轮询一次，没必要每次数几万个文件）
const DIR_TTL: Duration = Duration::from_secs(60);
/// 对话图的 URL 路径特征；其后紧跟 32 位十六进制 hash
const MARKERS: [&str; 3] = ["rc_gen_image/", "labis/image/", "isp-i18n-media/image/"];
/// 同比例的容差：比例差在最小差 + 这个值以内都算「比例相同」，再取像素最小的
const RATIO_TOL: f64 = 0.02;

/// 一张解析到的缓存图
pub struct ImageRef {
    /// 如 `f_0023f2`
    pub id: String,
    pub w: u32,
    pub h: u32,
}

/// 给每条消息里的图片位置（渲染宽高 (w,h) 列表，窗口顺序）找缓存里的图。
/// 返回同形状的结果，对不上的位置是 `None`；缓存目录不存在 / 解析不出东西时全是 `None`。
pub fn resolve(wanted: &[Vec<(i32, i32)>]) -> Vec<Vec<Option<ImageRef>>> {
    let mut images = Vec::new();
    if wanted.iter().any(|w| !w.is_empty()) {
        if let Some(dir) = cache_dir() {
            images = index(&dir);
        }
    }
    match_messages(wanted, &images)
}

/// 读一张缓存图，返回 `data:<mime>;base64,...`。id 必须匹配 `^f_[0-9a-f]{6}$`，
/// 魔数必须是 PNG/JPEG/WebP/GIF，大小 ≤ 8 MiB，否则 Err。
pub fn read_data_url(id: &str) -> Result<String, String> {
    let n = parse_id(id).ok_or_else(|| "图片 id 不合法".to_string())?;
    let dir = cache_dir().ok_or_else(|| "没找到豆包的缓存目录".to_string())?;
    // 路径只由校验过的编号拼出来：不含分隔符 / `..`
    let path = dir.join(format!("f_{n:06x}"));
    let f = open_shared(&path).map_err(|e| format!("读不到缓存图：{e}"))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err("缓存图太大".into());
    }
    let mut buf = Vec::with_capacity(len as usize);
    f.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Err("缓存图太大".into());
    }
    let kind = sniff(&buf).ok_or_else(|| "不是支持的图片格式".to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:{};base64,{b64}", kind.mime()))
}

// ───────────────────────── 图片格式 ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl Kind {
    fn mime(self) -> &'static str {
        match self {
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Webp => "image/webp",
            Kind::Gif => "image/gif",
        }
    }
}

fn sniff(b: &[u8]) -> Option<Kind> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(Kind::Png)
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Kind::Jpeg)
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(Kind::Webp)
    } else if b.starts_with(b"GIF") {
        Some(Kind::Gif)
    } else {
        None
    }
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32)
}

fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?]))
}

fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32)
}

fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(*b.get(i)? as u32 | (*b.get(i + 1)? as u32) << 8 | (*b.get(i + 2)? as u32) << 16)
}

/// 手工解析图片宽高（不引入图片库）；数据不够或格式不认识返回 None
fn dims(kind: Kind, b: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = match kind {
        // IHDR：偏移 16..24，大端
        Kind::Png => (be32(b, 16)?, be32(b, 20)?),
        Kind::Gif => (le16(b, 6)?, le16(b, 8)?),
        Kind::Jpeg => jpeg_dims(b)?,
        Kind::Webp => match b.get(12..16)? {
            b"VP8X" => (le24(b, 24)? + 1, le24(b, 27)? + 1),
            b"VP8 " => (le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff),
            b"VP8L" => {
                if *b.get(20)? != 0x2f {
                    return None;
                }
                let (b1, b2, b3, b4) = (*b.get(21)? as u32, *b.get(22)? as u32, *b.get(23)? as u32, *b.get(24)? as u32);
                (1 + (b1 | (b2 & 0x3f) << 8), 1 + ((b2 >> 6) | b3 << 2 | (b4 & 0xf) << 10))
            }
            _ => return None,
        },
    };
    (w > 0 && h > 0).then_some((w, h))
}

/// 扫 JPEG 段，找到 SOFn（`FFC0/C1/C2` 等）读高宽
fn jpeg_dims(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let m = b[i + 1];
        if m == 0xFF {
            i += 1; // 填充字节
            continue;
        }
        if m == 0x01 || (0xD0..=0xD8).contains(&m) {
            i += 2; // 没有长度的标记
            continue;
        }
        if m == 0xD9 || m == 0xDA {
            return None; // 图像结束 / 开始扫描数据，之前没有 SOF
        }
        let len = be16(b, i + 2)? as usize;
        // SOF0..SOF15，除去 DHT(C4) / JPG(C8) / DAC(CC)
        if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            let h = be16(b, i + 5)?;
            let w = be16(b, i + 7)?;
            return Some((w, h));
        }
        i += 2 + len.max(2);
    }
    None
}

// ───────────────────────── 缓存目录 / 共享读 ─────────────────────────

fn open_shared(p: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).share_mode(SHARE_ALL).open(p)
}

/// `f_XXXXXX` 的编号；只接受 6 位小写十六进制
fn parse_id(id: &str) -> Option<u32> {
    let hex = id.strip_prefix("f_")?;
    if hex.len() != 6 || !hex.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

fn count_external(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_name().to_str().is_some_and(|n| n.len() == 8 && n.starts_with("f_")))
                .count()
        })
        .unwrap_or(0)
}

/// `Profile 2` 优先；`Default` 的 `f_*` 更多才换过去
fn pick_dir(base: &Path) -> Option<PathBuf> {
    let mut best: Option<(usize, PathBuf)> = None;
    for profile in ["Profile 2", "Default"] {
        let dir = base.join("Doubao").join("User Data").join(profile).join("Cache").join("Cache_Data");
        if !dir.join("data_1").is_file() {
            continue;
        }
        let n = count_external(&dir);
        if best.as_ref().map_or(true, |(bn, _)| n > *bn) {
            best = Some((n, dir));
        }
    }
    best.map(|(_, d)| d)
}

fn cache_dir() -> Option<PathBuf> {
    static CHOSEN: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);
    let mut g = CHOSEN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, dir)) = g.as_ref() {
        if at.elapsed() < DIR_TTL {
            return dir.clone();
        }
    }
    let dir = std::env::var_os("LOCALAPPDATA").and_then(|b| pick_dir(Path::new(&b)));
    *g = Some((Instant::now(), dir.clone()));
    dir
}

// ───────────────────────── blockfile 解析 ─────────────────────────

struct Entry {
    state: i32,
    key_len: usize,
    long_key: u32,
    addrs: [u32; 4],
    inline_key: Vec<u8>,
}

fn rd_u32(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// 解析一个 256 字节的 EntryStore；明显不是 entry 的返回 None
fn parse_entry(b: &[u8]) -> Option<Entry> {
    if b.len() < ENTRY_SIZE {
        return None;
    }
    let state = rd_u32(b, 20) as i32;
    let key_len = rd_u32(b, 32) as i32;
    if key_len <= 0 || key_len > 4096 {
        return None;
    }
    let long_key = rd_u32(b, 36);
    let mut addrs = [0u32; 4];
    for (i, a) in addrs.iter_mut().enumerate() {
        *a = rd_u32(b, 56 + i * 4);
    }
    let key_len = key_len as usize;
    // key 不超过 160 字节时在本块内；更长的 key 仍是内联（long_key == 0），但会连续占用后面的块
    // （一个 entry 最多 4 块 = 1024 字节，key 最多 4*256-96-1）；超过才走 long_key 外部地址。
    // 带分区前缀的签名图片 URL 基本都是这种长 key。
    let inline_key = if long_key == 0 {
        if key_len > MAX_INLINE_KEY || 96 + key_len > b.len() {
            return None;
        }
        b[96..96 + key_len].to_vec()
    } else {
        Vec::new()
    };
    Some(Entry { state, key_len, long_key, addrs, inline_key })
}

/// 地址类型：0 外部文件，1 rankings，2 / 3 / 4 = 256 / 1024 / 4096 字节块
fn addr_type(a: u32) -> u32 {
    (a >> 28) & 7
}

fn external_no(a: u32) -> Option<u32> {
    (a & 0x8000_0000 != 0 && addr_type(a) == 0).then_some(a & 0x0fff_ffff)
}

/// 读长 key：块文件用 `data_<文件号>`，偏移 `8192 + 块号 * 块大小`
fn read_addr(dir: &Path, files: &mut HashMap<u32, Option<File>>, addr: u32, len: usize) -> Option<Vec<u8>> {
    if addr & 0x8000_0000 == 0 {
        return None;
    }
    let mut buf = vec![0u8; len];
    match addr_type(addr) {
        0 => {
            let mut f = open_shared(&dir.join(format!("f_{:06x}", addr & 0x0fff_ffff))).ok()?;
            f.read_exact(&mut buf).ok()?;
        }
        t @ 2..=4 => {
            let block_size = [256u64, 1024, 4096][(t - 2) as usize];
            let no = (addr >> 16) & 0xff;
            let slot = files.entry(no).or_insert_with(|| open_shared(&dir.join(format!("data_{no}"))).ok());
            let f = slot.as_mut()?;
            f.seek(SeekFrom::Start(BLOCK_HEADER + (addr & 0xffff) as u64 * block_size)).ok()?;
            f.read_exact(&mut buf).ok()?;
        }
        _ => return None,
    }
    Some(buf)
}

/// key 里的 URL（带分区前缀，从子串 `http` 起）命中三类对话图之一时，返回「类别 + 32 位 hash」
fn classify(key: &str) -> Option<String> {
    let url = &key[key.find("http")?..];
    for m in MARKERS {
        if let Some(p) = url.find(m) {
            let rest = &url[p + m.len()..];
            let hash = rest.get(..32)?;
            if hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Some(format!("{m}{}", hash.to_ascii_lowercase()));
            }
        }
    }
    None
}

#[derive(Clone)]
struct FileInfo {
    w: u32,
    h: u32,
    mtime: SystemTime,
}

#[derive(Clone)]
enum Probe {
    Image(FileInfo),
    /// 魔数不是图片：缓存起来别反复读（读不到文件不缓存，可能还没写完）
    NotImage,
}

fn read_head(f: &mut File, max: usize) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    f.seek(SeekFrom::Start(0)).ok()?;
    f.take(max as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn probe(dir: &Path, n: u32, infos: &mut HashMap<u32, Probe>) -> Option<FileInfo> {
    if let Some(p) = infos.get(&n) {
        return match p {
            Probe::Image(i) => Some(i.clone()),
            Probe::NotImage => None,
        };
    }
    if n > 0xff_ffff {
        return None;
    }
    let mut f = open_shared(&dir.join(format!("f_{n:06x}"))).ok()?;
    let mtime = f.metadata().ok()?.modified().ok()?;
    let mut head = read_head(&mut f, HEAD_FAST)?;
    let Some(kind) = sniff(&head) else {
        infos.insert(n, Probe::NotImage);
        return None;
    };
    let mut d = dims(kind, &head);
    if d.is_none() && kind == Kind::Jpeg && head.len() == HEAD_FAST {
        head = read_head(&mut f, HEAD_MAX)?; // EXIF 缩略图把 SOF 挤后面了
        d = dims(kind, &head);
    }
    let (w, h) = d?;
    let info = FileInfo { w, h, mtime };
    infos.insert(n, Probe::Image(info.clone()));
    Some(info)
}

/// 缓存里的一张图（同 hash 的所有变体合在一起）
#[derive(Clone, Debug)]
struct Img {
    variants: Vec<Var>,
    /// 首次加载点：变体里最小的 `f_` 编号及其 mtime
    first_f: u32,
    first_t: SystemTime,
}

#[derive(Clone, Debug)]
struct Var {
    f: u32,
    w: u32,
    h: u32,
}

struct State {
    dir: PathBuf,
    /// `data_1` 的 (长度, mtime)：没变化就复用，避免 3 秒一轮询时反复解析
    key: (u64, Option<SystemTime>),
    infos: HashMap<u32, Probe>,
    images: Vec<Img>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn index(dir: &Path) -> Vec<Img> {
    let Ok(meta) = std::fs::metadata(dir.join("data_1")) else { return Vec::new() };
    let key = (meta.len(), meta.modified().ok());
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = g.as_ref() {
        if s.dir == dir && s.key == key {
            return s.images.clone();
        }
    }
    let infos = match g.take() {
        Some(s) if s.dir == dir => s.infos,
        _ => HashMap::new(),
    };
    let (images, infos) = build(dir, infos);
    *g = Some(State { dir: dir.to_path_buf(), key, infos, images: images.clone() });
    images
}

fn build(dir: &Path, mut infos: HashMap<u32, Probe>) -> (Vec<Img>, HashMap<u32, Probe>) {
    // data_1 一般几 MB，整读；data_3 可能近 100MB，只按需 seek 读长 key
    let data1 = match open_shared(&dir.join("data_1")).and_then(|mut f| {
        let mut v = Vec::new();
        f.read_to_end(&mut v).map(|_| v)
    }) {
        Ok(v) => v,
        Err(_) => return (Vec::new(), infos),
    };
    let mut files: HashMap<u32, Option<File>> = HashMap::new();
    // 类别+hash → (f 编号, 该文件 mtime, 宽, 高)
    let mut groups: HashMap<String, Vec<(u32, SystemTime, u32, u32)>> = HashMap::new();

    let mut off = BLOCK_HEADER as usize;
    while off + ENTRY_SIZE <= data1.len() {
        // 传到文件尾的整段：长 key 内联时会越过本块
        let block = &data1[off..];
        let Some(e) = parse_entry(block) else {
            off += ENTRY_SIZE;
            continue;
        };
        // 内联长 key 占用的后续块不是 entry，跳过，免得把 key 文本当头去解析
        off += if e.long_key == 0 { (96 + e.key_len).div_ceil(ENTRY_SIZE) * ENTRY_SIZE } else { ENTRY_SIZE };
        if e.state != 0 {
            continue;
        }
        let key_bytes = if e.long_key == 0 {
            e.inline_key
        } else {
            match read_addr(dir, &mut files, e.long_key, e.key_len) {
                Some(k) => k,
                None => continue,
            }
        };
        let key = String::from_utf8_lossy(&key_bytes);
        let Some(hash) = classify(&key) else { continue };
        for a in e.addrs {
            let Some(n) = external_no(a) else { continue };
            if let Some(info) = probe(dir, n, &mut infos) {
                groups.entry(hash.clone()).or_default().push((n, info.mtime, info.w, info.h));
                break;
            }
        }
    }

    let mut images: Vec<Img> = groups
        .into_values()
        .filter_map(|mut v| {
            v.sort_by_key(|x| x.0);
            let (first_f, first_t, _, _) = *v.first()?;
            let mut variants: Vec<Var> = Vec::new();
            for (f, _, w, h) in v {
                // 同尺寸的重复加载只留最早的一个
                if !variants.iter().any(|x| x.w == w && x.h == h) {
                    variants.push(Var { f, w, h });
                }
            }
            Some(Img { variants, first_f, first_t })
        })
        .collect();
    images.sort_by_key(|i| i.first_f);
    (images, infos)
}

// ───────────────────────── 分批 / 匹配（纯函数） ─────────────────────────

fn abs_diff(a: SystemTime, b: SystemTime) -> Duration {
    a.duration_since(b).unwrap_or_else(|e| e.duration())
}

/// `images` 已按首次加载点排序：相邻两张 mtime 相差超过 10 秒就切一批。返回每批的下标
fn make_batches(images: &[Img]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let split = match i.checked_sub(1) {
            Some(p) => abs_diff(img.first_t, images[p].first_t) > BATCH_GAP,
            None => true,
        };
        if split {
            out.push(Vec::new());
        }
        if let Some(last) = out.last_mut() {
            last.push(i);
        }
    }
    out
}

/// 展示用变体：只看宽度 ≥ 渲染宽度的，优先宽高比最接近渲染框的，比例相同取像素最小的；
/// 没有宽度够的就取最大的
fn pick_variant(img: &Img, (rw, rh): (i32, i32)) -> Option<ImageRef> {
    let px = |v: &Var| v.w as u64 * v.h as u64;
    let target = if rw > 0 && rh > 0 { Some(rw as f64 / rh as f64) } else { None };
    let diff = |v: &Var| target.map_or(0.0, |t| (v.w as f64 / v.h as f64 - t).abs());
    let big_enough: Vec<&Var> = img.variants.iter().filter(|v| v.w as i64 >= rw as i64).collect();
    let chosen = if big_enough.is_empty() {
        img.variants.iter().max_by_key(|v| px(v))?
    } else {
        let best = big_enough.iter().map(|v| diff(v)).fold(f64::MAX, f64::min);
        big_enough.into_iter().filter(|v| diff(v) <= best + RATIO_TOL).min_by_key(|v| px(v))?
    };
    Some(ImageRef { id: format!("f_{:06x}", chosen.f), w: chosen.w, h: chosen.h })
}

/// 从最后一条有图的消息往前、同时从最新一批往前：每条消息在「比上一次命中更旧」的批里，
/// 从新到旧找第一个图数恰好等于消息图数的批；找不到该消息全部 None（不移动游标）。
fn match_messages(wanted: &[Vec<(i32, i32)>], images: &[Img]) -> Vec<Vec<Option<ImageRef>>> {
    let mut out: Vec<Vec<Option<ImageRef>>> = wanted.iter().map(|w| w.iter().map(|_| None).collect()).collect();
    let batches = make_batches(images);
    let mut limit = batches.len(); // 只看下标 < limit 的批：批不会被两条消息占用，也不会倒着对
    for (mi, w) in wanted.iter().enumerate().rev() {
        let n = w.len();
        if n == 0 {
            continue;
        }
        let Some(bi) = (0..limit).rev().find(|&b| batches[b].len() == n) else { continue };
        limit = bi;
        for (k, &ii) in batches[bi].iter().enumerate() {
            out[mi][k] = pick_variant(&images[ii], w[k]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b
    }

    fn img(f: u32, secs: u64, variants: &[(u32, u32, u32)]) -> Img {
        Img {
            variants: variants.iter().map(|&(f, w, h)| Var { f, w, h }).collect(),
            first_f: f,
            first_t: SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + secs),
        }
    }

    #[test]
    fn parses_png_jpeg_webp_dims() {
        assert_eq!(dims(Kind::Png, &png(384, 512)), Some((384, 512)));
        // JPEG：SOI + APP0（长度 16）+ SOF0（高 289 = 0x0121，宽 385 = 0x0181）
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        j.extend([0u8; 14]);
        j.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0x21, 0x01, 0x81, 0x03]);
        assert_eq!(sniff(&j), Some(Kind::Jpeg));
        assert_eq!(dims(Kind::Jpeg, &j), Some((385, 289)));
        // WebP VP8X：宽高各减 1 存 24 位小端（1536x1024）
        let mut w = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        w.extend([10, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0x05, 0x00, 0xFF, 0x03, 0x00]);
        assert_eq!(sniff(&w), Some(Kind::Webp));
        assert_eq!(dims(Kind::Webp, &w), Some((1536, 1024)));
        // WebP VP8（有损）：26..30 小端，低 14 位
        let mut l = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        l.extend([0u8; 10]);
        l.extend([0x00, 0x02, 0x80, 0x01]); // 512 x 384
        assert_eq!(dims(Kind::Webp, &l), Some((512, 384)));
        assert_eq!(dims(Kind::Png, &[0x89, b'P']), None);
    }

    #[test]
    fn batches_split_on_gap() {
        let imgs = vec![
            img(1, 0, &[(1, 384, 384)]),
            img(2, 1, &[(2, 384, 384)]),
            img(3, 9, &[(3, 384, 384)]),
            img(10, 60, &[(10, 448, 336)]),
            img(11, 65, &[(11, 448, 336)]),
            img(20, 200, &[(20, 384, 384)]),
        ];
        assert_eq!(make_batches(&imgs), vec![vec![0, 1, 2], vec![3, 4], vec![5]]);
        assert!(make_batches(&[]).is_empty());
    }

    #[test]
    fn variant_prefers_ratio_then_small() {
        let i = img(1, 0, &[(1, 384, 384), (2, 1536, 1536), (3, 448, 336), (4, 600, 450), (5, 1440, 1080)]);
        // 渲染 353x353：宽度够的是 384 / 1536 / 448 / 600 / 1440，1:1 里取最小的 384
        assert_eq!(pick_variant(&i, (353, 353)).unwrap().id, "f_000001");
        // 渲染 385x289（4:3）：宽度够 448 / 600 / 1440，比例相同取像素最小的 448
        assert_eq!(pick_variant(&i, (385, 289)).unwrap().id, "f_000003");
        // 没有宽度够的：取最大的
        assert_eq!(pick_variant(&i, (4000, 3000)).unwrap().id, "f_000002");
    }

    #[test]
    fn matches_messages_to_batches() {
        // 时间顺序：4 张 / 5 张 / 5 张
        let mut imgs = Vec::new();
        let mut f = 1;
        for (secs, n) in [(0u64, 4u32), (100, 5), (200, 5)] {
            for k in 0..n {
                imgs.push(img(f, secs + k as u64, &[(f, 384, 384)]));
                f += 1;
            }
        }
        let wanted = vec![vec![(353, 353); 4], vec![(353, 353); 5], vec![], vec![(353, 353); 5]];
        let r = match_messages(&wanted, &imgs);
        let ids = |m: usize| r[m].iter().map(|x| x.as_ref().map(|i| i.id.clone())).collect::<Vec<_>>();
        assert!(ids(0).iter().all(|x| x.is_some()) && ids(0).len() == 4);
        assert_eq!(ids(0)[0].as_deref(), Some("f_000001"));
        assert_eq!(ids(1)[0].as_deref(), Some("f_000005"));
        assert!(r[2].is_empty());
        assert_eq!(ids(3)[0].as_deref(), Some("f_00000a"));
        // 数量不符：6 张的消息找不到批；同一批不被两条消息重复占用
        let r = match_messages(&[vec![(353, 353); 6], vec![(353, 353); 5], vec![(353, 353); 5], vec![(353, 353); 5]], &imgs);
        assert!(r[0].iter().all(|x| x.is_none()));
        assert!(r[1].iter().all(|x| x.is_none()));
        assert!(r[2].iter().all(|x| x.is_some()));
        assert!(r[3].iter().all(|x| x.is_some()));
        assert_ne!(r[2][0].as_ref().unwrap().id, r[3][0].as_ref().unwrap().id);
        // 没有缓存：全 None
        assert!(match_messages(&[vec![(1, 1)]], &[])[0][0].is_none());
    }

    #[test]
    fn classifies_only_conversation_images() {
        let h = "0123456789abcdef0123456789ABCDEF";
        let gen = format!("1/0/_dk_chrome://doubao-chat chrome://doubao https://p6.byteimg.com/x/rc_gen_image/{h}~tplv.jpeg?sig=1");
        assert_eq!(classify(&gen), Some(format!("rc_gen_image/{}", h.to_ascii_lowercase())));
        assert!(classify(&format!("1/0/_dk_ https://p6.byteimg.com/labis/image/{h}.webp")).is_some());
        assert!(classify(&format!("1/0/_dk_ https://p6.byteimg.com/isp-i18n-media/image/{h}.png")).is_some());
        // 头像 / 界面图不算
        assert!(classify(&format!("1/0/_dk_ https://p6.byteimg.com/tos-cn-i-a9rns2rl98/{h}.png")).is_none());
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["../x", "f_12", "f_00001g", "f_0000001", "F_000001", "f_00001G", "", "f_/../ab"] {
            assert!(read_data_url(id).is_err(), "{id}");
            assert!(parse_id(id).is_none(), "{id}");
        }
        assert_eq!(parse_id("f_0023f2"), Some(0x23f2));
    }

    /// 只读本机缓存，必须在豆包开着的时候手动跑：
    /// `cargo test --lib doubao -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机豆包客户端开着"]
    fn installed_client_cache() {
        let r = resolve(&[vec![(353, 353); 5], vec![(385, 289); 4]]);
        for (i, msg) in r.iter().enumerate() {
            for (k, x) in msg.iter().enumerate() {
                match x {
                    Some(x) => eprintln!("消息 {i} 图 {k}: {} {}x{}", x.id, x.w, x.h),
                    None => eprintln!("消息 {i} 图 {k}: None"),
                }
            }
        }
        assert_eq!(r.len(), 2);
    }
}
