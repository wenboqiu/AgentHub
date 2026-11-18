//! 读豆包窗口里「当前挂着」的对话消息（UI Automation，只读）。
//!
//! 豆包客户端不把正文落盘：`doubao.rs` 只能从 `saman_*.log` 拿到会话状态和标题，
//! `Profile 2\IndexedDB` 里也只有应用配置和 persona。唯一能看到正文的地方就是它自己的界面，
//! 所以这里用 UIA 把虚拟列表里已经渲染出来的消息行抓下来：
//!
//! - 只能走 **RawViewWalker**：`FindAll` 只给控制视图，`v_list_row` / `list_items` 这些
//!   布局容器不在里面，得自己按原始树遍历；
//! - 行 = class 为 `v_list_row` 的容器（虚拟列表按需渲染，滚出视野的行会被回收，所以只有最近一段）；
//! - 角色 = 行内第一个容器的类名：助手是 `relative grid w-full grid-cols-...`，
//!   用户是右对齐的气泡 `... container-xxxx`；类名换了就退回几何判断（内容起点偏右算用户）；
//! - 正文 = 行内所有 Text 节点，按树序拼；容器 Text 和它的子节点同名，按「矩形更小且被包住」去重。
//!
//! - 图片：UIA 拿不到字节，`[图片]` 行只记渲染宽高；真实图片由 `doubao_cache` 读 Chromium
//!   磁盘缓存按批匹配（组内顺序未验证，可能错位），对不上的位置 `images[k]` 为 null。
//!
//! 不做任何写入：不点按钮、不发消息、不碰 cookie。

use serde::Serialize;
use std::mem::ManuallyDrop;
use windows::core::{BSTR, Interface, IUnknown};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::{
    VariantClear, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BSTR,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTreeWalker,
    UIA_ButtonControlTypeId, UIA_ImageControlTypeId, UIA_NamePropertyId, UIA_PROPERTY_ID,
    UIA_TextControlTypeId, TreeScope_Descendants,
};

/// 一条抓到的消息。id 由前端按序号生成，这里只给角色和正文。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisibleMessage {
    pub role: String,
    pub text: String,
    /// 按文本里 `[图片]` 行的出现顺序一一对应；对不上缓存的是 None（null）
    pub images: Vec<Option<ImageOut>>,
}

/// 匹配到的缓存图：id 交给 `doubao_image` 命令取字节
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageOut {
    pub id: String,
    pub w: u32,
    pub h: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWindow {
    /// 窗口标题，形如「<会话名> - 豆包」
    pub title: String,
    pub messages: Vec<VisibleMessage>,
}

const MAX_MESSAGES: usize = 40;
const MAX_TEXT: usize = 8000;
/// 小于这个边长的图片当图标 / 头像，不进正文
const IMAGE_MIN_PX: i32 = 64;
/// 图片占位（alt 恒为「image」没信息量，不带）
const IMAGE_MARK: &str = "[图片]";
/// 原始树比控制视图大得多，给个上限防止卡死（正常一屏几百个节点）
const MAX_NODES: usize = 20000;

pub fn read() -> Result<DoubaoWindow, String> {
    let hwnd = find_window().ok_or_else(|| "没找到豆包窗口（豆包没在运行？）".to_string())?;
    let _com = Com::init();
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None::<&IUnknown>, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("UI Automation 初始化失败：{e}"))?;
        // 豆包是 Chromium，卡住时同步调用会一直等；限制一次收发的时间
        if let Ok(a2) = automation.cast::<IUIAutomation2>() {
            let _ = a2.SetConnectionTimeout(2000);
            let _ = a2.SetTransactionTimeout(4000);
        }
        let root = automation
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("读不到豆包窗口：{e}"))?;
        let walker = automation
            .RawViewWalker()
            .map_err(|e| format!("UI Automation 遍历器创建失败：{e}"))?;

        let title = name_of(&root);

        // 一次 FindFirst 让 UIA 在提供方进程里自己扫，比逐节点跨进程问类名快得多
        let editor = find_by(&automation, &root, UIA_NamePropertyId, "doc_editor")
            .ok_or_else(|| "豆包窗口不在对话页（没找到对话区）".to_string())?;
        // 消息列表没有名字，不是控制元素，FindFirst 看不到，只能在对话区里走原始树
        let mut budget = MAX_NODES;
        let list = find_raw(&walker, &editor, &mut budget, &|el| class_of(el).trim() == "list_items").unwrap_or(editor);
        let mut pending: Vec<(VisibleMessage, Vec<(i32, i32)>)> = Vec::new();
        let mut budget = MAX_NODES;
        for row in rows(&walker, &list, &mut budget) {
            let Some(role) = role_of(&walker, &row) else { continue };
            let (text, mut sizes) = row_text(&walker, &row);
            // 虚拟列表里还有「今天 08:25」这类日期分隔行，不是消息
            if text.is_empty() || looks_like_divider(&text) {
                continue;
            }
            let text = clip(clean(&text), MAX_TEXT);
            // clean 会从最后一条时间行截断（时间行之后的图是界面元素）：按留下的 `[图片]` 行数对齐尺寸
            sizes.resize(text.lines().filter(|l| *l == IMAGE_MARK).count(), (0, 0));
            pending.push((VisibleMessage { role, text, images: Vec::new() }, sizes));
        }
        // 先丢掉超出的最旧消息，保证 resolve 的入参与最终 messages 同序同长度
        if pending.len() > MAX_MESSAGES {
            pending.drain(..pending.len() - MAX_MESSAGES);
        }
        let wanted: Vec<Vec<(i32, i32)>> = pending.iter().map(|(_, s)| s.clone()).collect();
        let mut resolved = crate::doubao_cache::resolve(&wanted);
        let mut messages = Vec::with_capacity(pending.len());
        for (i, (mut m, sizes)) in pending.into_iter().enumerate() {
            let mut got = if i < resolved.len() { std::mem::take(&mut resolved[i]) } else { Vec::new() };
            got.resize_with(sizes.len(), || None);
            m.images = got
                .into_iter()
                .map(|x| x.map(|r| ImageOut { id: r.id, w: r.w, h: r.h }))
                .collect();
            messages.push(m);
        }
        Ok(DoubaoWindow { title, messages })
    }
}

fn find_window() -> Option<HWND> {
    // 豆包是多进程的，只有一个子进程挂着主窗口；逐个试，别只看第一个
    let procs = crate::focus::win::snapshot();
    for (pid, p) in &procs {
        if p.exe.eq_ignore_ascii_case("Doubao.exe") {
            if let Some(h) = crate::focus::win::window_of(*pid) {
                return Some(HWND(h as _));
            }
        }
    }
    None
}

/// COM 每次调用单独初始化：命令跑在阻塞线程池里，线程可能被复用也可能被回收
struct Com;

impl Com {
    fn init() -> Self {
        unsafe {
            // 已经初始化成别的套间（STA）时返回 RPC_E_CHANGED_MODE，继续用即可
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        Com
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// 原始树深度优先找工作区里的某个布局容器（控制视图里没有）
unsafe fn find_raw(
    w: &IUIAutomationTreeWalker,
    el: &IUIAutomationElement,
    budget: &mut usize,
    pred: &dyn Fn(&IUIAutomationElement) -> bool,
) -> Option<IUIAutomationElement> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    if pred(el) {
        return Some(el.clone());
    }
    for child in kids(w, el) {
        if let Some(hit) = find_raw(w, &child, budget, pred) {
            return Some(hit);
        }
    }
    None
}

/// 用属性条件做一次 FindFirst：UIA 在提供方进程里自己扫，比逐节点跨进程取属性快得多
unsafe fn find_by(
    automation: &IUIAutomation,
    root: &IUIAutomationElement,
    prop: UIA_PROPERTY_ID,
    value: &str,
) -> Option<IUIAutomationElement> {
    let v = Variant::new(value);
    let cond = automation.CreatePropertyCondition(prop, v.as_ref()).ok()?;
    root.FindFirst(TreeScope_Descendants, &cond).ok()
}

/// `CreatePropertyCondition` 要一个 VT_BSTR 的 VARIANT；BSTR 归我们所有，用完要回收
struct Variant(VARIANT);

impl Variant {
    fn new(s: &str) -> Self {
        let mut v = VARIANT::default();
        v.Anonymous = VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { bstrVal: ManuallyDrop::new(BSTR::from(s)) },
            }),
        };
        Variant(v)
    }

    fn as_ref(&self) -> &VARIANT {
        &self.0
    }
}

impl Drop for Variant {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

unsafe fn kids(w: &IUIAutomationTreeWalker, el: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    let mut out = Vec::new();
    let mut cur = w.GetFirstChildElement(el).ok();
    while let Some(c) = cur {
        cur = w.GetNextSiblingElement(&c).ok();
        out.push(c);
        if out.len() > 5000 {
            break;
        }
    }
    out
}

unsafe fn name_of(el: &IUIAutomationElement) -> String {
    el.CurrentName().map(|b| b.to_string()).unwrap_or_default()
}

unsafe fn class_of(el: &IUIAutomationElement) -> String {
    el.CurrentClassName().map(|b| b.to_string()).unwrap_or_default()
}

unsafe fn rect_of(el: &IUIAutomationElement) -> Option<RECT> {
    let r = el.CurrentBoundingRectangle().ok()?;
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

/// 消息列表里的行；顶部 / 底部占位行（`*_indicator`）跳过
unsafe fn rows(
    w: &IUIAutomationTreeWalker,
    list: &IUIAutomationElement,
    budget: &mut usize,
) -> Vec<IUIAutomationElement> {
    let mut out = Vec::new();
    for row in kids(w, list) {
        *budget = budget.saturating_sub(1);
        if !class_of(&row).contains("v_list_row") {
            continue;
        }
        out.push(row);
    }
    out
}

/// 行的角色：类名优先，认不出来就按内容起点是否偏右判断
unsafe fn role_of(w: &IUIAutomationTreeWalker, row: &IUIAutomationElement) -> Option<String> {
    let first = kids(w, row).into_iter().next()?;
    let cls = class_of(&first);
    if cls.contains("indicator") {
        return None;
    }
    if cls.contains("grid") {
        return Some("assistant".into());
    }
    if cls.contains("container-") {
        return Some("user".into());
    }
    // 日期分隔行 / 类名改版后的兜底：用户气泡靠右，助手正文从左侧内容栏开始
    let row_rect = rect_of(row)?;
    let mut texts = Vec::new();
    let mut budget = MAX_NODES;
    texts_of(w, row, &mut budget, &mut texts);
    let left = texts.iter().map(|(r, _)| r.left).min()?;
    let threshold = row_rect.left + (row_rect.right - row_rect.left) * 3 / 10;
    Some(if left > threshold { "user" } else { "assistant" }.into())
}

/// 行内所有 Text（按树序，含坐标）
unsafe fn texts_of(
    w: &IUIAutomationTreeWalker,
    el: &IUIAutomationElement,
    budget: &mut usize,
    out: &mut Vec<(RECT, String)>,
) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
    // 按钮（复制 / 朗读 / 推荐追问）不是对话内容，整棵子树都不要
    if ct == UIA_ButtonControlTypeId.0 {
        return;
    }
    // 图片字节拿不到（UIA 只给矩形和 alt），留个占位让前端知道这里有图；头像 / 图标太小，不算
    if ct == UIA_ImageControlTypeId.0 {
        if let Some(r) = rect_of(el) {
            if r.right - r.left >= IMAGE_MIN_PX && r.bottom - r.top >= IMAGE_MIN_PX {
                out.push((r, IMAGE_MARK.to_string()));
            }
        }
        return;
    }
    if ct == UIA_TextControlTypeId.0 {
        let text = name_of(el);
        if !text.trim().is_empty() {
            if let Some(r) = rect_of(el) {
                out.push((r, text));
            }
            return; // 有名字的 Text 不再往下走：子节点是排版碎片 / 同一段文字的重复
        }
        // 没名字的 Text 只是个包裹层（豆包把一句话拆成几个 span 时会出现），继续往下
    }
    for child in kids(w, el) {
        texts_of(w, &child, budget, out);
    }
}

/// 拼一段正文：换行由纵坐标是否变化判断，同一行直接相接（中文常被拆成多段）。
/// 同时返回每个 `[图片]` 的渲染 (宽, 高)，顺序与正文里的 `[图片]` 行一致
unsafe fn row_text(w: &IUIAutomationTreeWalker, row: &IUIAutomationElement) -> (String, Vec<(i32, i32)>) {
    let mut items: Vec<(RECT, String)> = Vec::new();
    let mut budget = MAX_NODES;
    texts_of(w, row, &mut budget, &mut items);
    // 容器的 Text 和它唯一的子 Text 同名，且矩形把子节点包住：只留里面那个
    let keep: Vec<&(RECT, String)> = items
        .iter()
        .filter(|(r, t)| {
            !items
                .iter()
                .any(|(r2, t2)| t2 == t && area(r2) < area(r) && contains(r, r2))
        })
        .collect();

    let mut out = String::new();
    let mut prev: Option<RECT> = None;
    let mut prev_image = false;
    let mut sizes = Vec::new();
    for (r, t) in keep {
        if let Some(p) = prev {
            let dy = ((r.top + r.bottom) / 2) - ((p.top + p.bottom) / 2);
            // 图片之间 / 图片与文字之间一律换行（并排的图纵坐标相同，会被误拼成一行）
            if dy.abs() > 4 || t == IMAGE_MARK || prev_image {
                out.push('\n');
            }
        }
        out.push_str(t.trim_end());
        prev = Some(*r);
        prev_image = t == IMAGE_MARK;
        if prev_image {
            sizes.push((r.right - r.left, r.bottom - r.top));
        }
    }
    (out.trim().to_string(), sizes)
}

const fn area(r: &RECT) -> i64 {
    (r.right - r.left) as i64 * (r.bottom - r.top) as i64
}

fn contains(outer: &RECT, inner: &RECT) -> bool {
    inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
}

/// 消息气泡末尾会带一行「今天 08:25」的时间，后面跟着复制 / 朗读 / 推荐追问这些界面元素：
/// 从最后一条时间行截断，留下的才是正文
fn clean(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if let Some(i) = lines.iter().rposition(|l| is_time_line(l)) {
        lines.truncate(i);
    }
    lines.join("\n").trim().to_string()
}

fn is_time_line(line: &str) -> bool {
    let t = line.trim();
    let rest = ["今天", "昨天", "前天"].iter().find_map(|p| t.strip_prefix(p)).unwrap_or(t).trim();
    // HH:MM，允许带「上午 / 下午」
    let rest = rest.trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = rest.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else { return false };
    let (Ok(h), Ok(m)) = (h.parse::<u32>(), m.trim().parse::<u32>()) else { return false };
    // 「上午 08:25」里的汉字要允许，但整行不能太长（避免把正文里的时间当分隔）
    h < 24 && m < 60 && t.chars().count() <= 12 && !t.contains('，')
}

/// 「今天 08:25」「昨天」「2026年11月8日」这类分隔行
fn looks_like_divider(text: &str) -> bool {
    let t = text.trim();
    if t.chars().count() > 16 {
        return false;
    }
    let head: String = t.chars().take(3).collect();
    ["今天", "昨天", "前天", "星期"].contains(&head.as_str())
        || t.starts_with(|c: char| c.is_ascii_digit())
        || t.contains('年') && t.contains('月')
}

fn clip(mut s: String, max: usize) -> String {
    if s.chars().count() > max {
        s = s.chars().take(max).collect::<String>();
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_matches_frontend_shape() {
        let w = DoubaoWindow {
            title: "某个对话 - 豆包".into(),
            messages: vec![VisibleMessage { role: "user".into(), text: "你好".into(), images: vec![] }],
        };
        let v = serde_json::to_value(&w).unwrap();
        assert_eq!(v["title"], "某个对话 - 豆包");
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["text"], "你好");
        assert_eq!(v["messages"][0]["images"], serde_json::json!([]));
    }

    /// 只读本机窗口，必须在豆包开着的时候手动跑：
    /// `cargo test --lib doubao_ui -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机豆包客户端开着"]
    fn installed_client_messages() {
        let w = read().expect("read doubao window");
        eprintln!("title = {}", w.title);
        for m in &w.messages {
            eprintln!("[{}] {}", m.role, m.text.replace('\n', " / "));
        }
        for m in &w.messages {
            let marks = m.text.lines().filter(|l| *l == IMAGE_MARK).count();
            assert_eq!(m.images.len(), marks, "images 长度应等于 [图片] 行数");
            if marks > 0 {
                eprintln!("    images = {}", serde_json::to_string(&m.images).unwrap());
            }
        }
        assert!(!w.messages.is_empty());
    }
}

