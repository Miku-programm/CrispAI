/**
 * 管理后台的补充功能，由服务端注入到后台页面（见 services/hono.service.ts）：
 *
 * 1. 项目管理页里的「客服接待」标签：在线状态、离线/超时接管、刷屏屏蔽
 * 2. 顶栏的「退出登录」按钮
 *
 * 后台前端是打包后的产物，源码不在这个仓库里，没法直接加页面，所以这里在页面渲染后把
 * 标签和面板接进去。外观完全复用后台已有的样式类（下面 CLS 里的类名都抄自后台自己渲染出来
 * 的元素），因此浅色/深色主题、圆角、间距都和其他标签一致。
 *
 * 前端重新打包后如果结构变了（找不到标签栏），这段脚本什么都不会做，后台其余部分不受影响；
 * 那时需要对照新的页面结构更新这里的选择器和类名。
 */
(function () {
  "use strict";
  if (window.__crispaiDashboardExtras) return;
  window.__crispaiDashboardExtras = true;

  // ---------------------------------------------------------------------------
  // 后台已有的样式类
  // ---------------------------------------------------------------------------
  var BUTTON =
    "z-0 group relative inline-flex items-center justify-center box-border appearance-none select-none whitespace-nowrap font-normal subpixel-antialiased overflow-hidden tap-highlight-transparent transform-gpu data-[pressed=true]:scale-[0.97] cursor-pointer outline-solid outline-transparent data-[focus-visible=true]:z-10 data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-focus data-[focus-visible=true]:outline-offset-2 gap-2 rounded-medium [&>svg]:max-w-[theme(spacing.8)] transition-transform-colors-opacity motion-reduce:transition-none data-[hover=true]:opacity-hover";
  var CLS = {
    panel: "py-3 px-1 data-[inert=true]:hidden outline-solid outline-transparent data-[focus-visible=true]:z-10 data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-focus data-[focus-visible=true]:outline-offset-2",
    card: "flex flex-col relative overflow-hidden h-auto text-foreground box-border bg-content1 outline-solid outline-transparent shadow-small rounded-medium transition-transform-background motion-reduce:transition-none p-2",
    cardHeader: "p-3 z-10 w-full shrink-0 overflow-inherit color-inherit subpixel-antialiased rounded-t-medium flex flex-col sm:flex-row justify-between items-center gap-4",
    cardBody: "relative w-full p-3 flex-auto flex-col place-content-inherit align-items-inherit h-auto break-words text-left overflow-y-auto subpixel-antialiased flex gap-3",
    headerActions: "flex gap-4",
    row: "w-full bg-content2 rounded-medium p-4 inline-flex flex-col gap-2 sm:flex-row items-start sm:items-center justify-between",
    rowSwitch: "w-full bg-content2 rounded-medium p-4 inline-flex gap-2 sm:flex-row items-center justify-between",
    group: "w-full bg-content2 rounded-medium p-4 inline-flex flex-col gap-2 items-start justify-between",
    groupLine: "flex flex-col sm:flex-row w-full gap-2 justify-between items-start sm:items-center",
    groupLineNext: "flex flex-col sm:flex-row w-full gap-2 justify-between items-start sm:items-center mt-3",
    label: "flex flex-col flex-1",
    title: "text-medium",
    desc: "text-tiny text-default-400",
    chip: "relative max-w-fit min-w-min inline-flex items-center justify-between box-border whitespace-nowrap px-1 h-7 text-small rounded-medium bg-default text-default-foreground",
    chipText: "flex-1 text-inherit font-normal px-2",
    code: "px-2 py-1 h-fit font-mono font-normal inline-block bg-default/40 text-default-700 text-small rounded-small overflow-auto whitespace-pre-wrap break-words",
    inputBase: "group flex flex-col data-[hidden=true]:hidden w-full relative justify-end",
    inputWrapper: "relative w-full inline-flex tap-highlight-transparent flex-row items-center shadow-xs px-3 gap-3 border-medium border-default-200 data-[hover=true]:border-default-400 group-data-[focus=true]:border-default-foreground group-data-[focus=true]:data-[hover=true]:border-default-foreground h-10 min-h-10 rounded-medium !duration-150 transition-colors motion-reduce:transition-none",
    inputInner: "inline-flex w-full items-center h-full box-border",
    input: "w-full font-normal bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent text-small",
    textareaWrapper: "relative w-full inline-flex tap-highlight-transparent flex-row items-center shadow-xs px-3 gap-3 border-medium border-default-200 data-[hover=true]:border-default-400 group-data-[focus=true]:border-default-foreground group-data-[focus=true]:data-[hover=true]:border-default-foreground h-10 min-h-10 rounded-medium !h-auto !duration-150 transition-colors motion-reduce:transition-none py-2",
    textareaInner: "inline-flex w-full h-full box-border items-start",
    textarea: "w-full font-normal bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent text-small resize-none",
    switchLabel: "group relative max-w-fit inline-flex items-center justify-start cursor-pointer touch-none tap-highlight-transparent select-none",
    switchInput: "font-inherit text-[100%] leading-[1.15] m-0 p-0 overflow-visible box-border absolute top-0 w-full h-full opacity-[0.0001] z-[1] cursor-pointer disabled:cursor-default",
    switchTrack: "px-1 relative inline-flex items-center justify-start shrink-0 overflow-hidden bg-default-200 rounded-full outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background group-data-[selected=true]:text-primary-foreground w-12 h-7 transition-background group-data-[selected=true]:bg-success dark:group-data-[selected=true]:bg-success",
    switchThumb: "z-10 flex items-center justify-center bg-white shadow-small rounded-full origin-right pointer-events-none w-5 h-5 text-small group-data-[selected=true]:ms-5 transition-all group-data-[pressed=true]:w-6 group-data-[selected]:group-data-[pressed]:ml-4",
    buttonSolid: BUTTON + " px-4 min-w-20 h-10 text-small bg-foreground text-background",
    buttonSolidSmall: BUTTON + " px-3 min-w-16 h-8 text-tiny bg-foreground text-background",
    buttonBordered: BUTTON + " border-medium px-4 min-w-20 h-10 text-small border-default bg-default-100 text-default-foreground",
    buttonBorderedSmall: BUTTON + " border-medium px-3 min-w-16 h-8 text-tiny border-default bg-default-100 text-default-foreground",
    buttonDanger: BUTTON + " px-4 min-w-20 h-10 text-small bg-danger/20 text-danger-600 dark:text-danger-500",
    selectTrigger: "relative px-3 w-full inline-flex shadow-xs outline-solid outline-transparent tap-highlight-transparent border-medium border-default-200 data-[hover=true]:border-default-400 data-[focus=true]:border-default-foreground data-[focus=true]:data-[hover=true]:border-default-foreground rounded-medium items-center h-10 min-h-10",
    selectIcon: "absolute end-3 w-4 h-4 transition-none",
    controlWidth: "w-full sm:w-56",
  };

  // 后台样式里没有、只有这里用得到的少量样式（颜色仍取后台的主题变量）
  var STYLE =
    "[data-crispai-active]>[role=tabpanel]:not([data-crispai-panel]){display:none!important}" +
    "[data-crispai-active] [role=tab]:not([data-crispai-tab]) [data-slot=tabContent]{color:hsl(var(--heroui-default-500))!important}" +
    // 后台的布局类（flex 等）会盖过 hidden 属性，这里保证隐藏的行确实不显示
    "[data-crispai-panel][hidden],[data-crispai-panel] [hidden]{display:none!important}" +
    ".crispai-select{appearance:none;-webkit-appearance:none;background:transparent;border:0;outline:0;width:100%;height:100%;padding-inline-end:1.5rem;font:inherit;font-size:var(--heroui-font-size-small);color:hsl(var(--heroui-default-foreground));cursor:pointer}" +
    ".crispai-select option{color:hsl(var(--heroui-foreground));background:hsl(var(--heroui-content1))}" +
    ".crispai-section{margin:.5rem .25rem 0;font-size:var(--heroui-font-size-small);color:hsl(var(--heroui-default-500))}" +
    ".crispai-days{display:flex;flex-wrap:wrap;gap:.5rem}" +
    ".crispai-day{cursor:pointer;border:0;font:inherit;font-size:var(--heroui-font-size-small)}" +
    ".crispai-day[aria-pressed=true]{background:hsl(var(--heroui-foreground));color:hsl(var(--heroui-background))}" +
    ".crispai-inline{display:flex;gap:.5rem;align-items:center}" +
    ".crispai-unit{width:6.5rem}" +
    ".crispai-range{width:100%}@media (min-width:640px){.crispai-range{width:21rem}}" +
    ".crispai-list{display:flex;flex-direction:column;gap:.5rem;width:100%;margin-top:.75rem}" +
    ".crispai-item{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;justify-content:space-between;padding:.625rem .75rem;border-radius:var(--heroui-radius-small);background:hsl(var(--heroui-content1))}" +
    ".crispai-item-main{display:flex;flex-direction:column;gap:.125rem;min-width:0;flex:1 1 16rem}" +
    ".crispai-tab-icon{width:1em;height:1em;flex:none}" +
    "[data-crispai-panel] [disabled]{opacity:.5;cursor:default}" +
    ".crispai-toast{position:fixed;top:32px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;align-items:center;gap:6px;width:356px;max-width:calc(100vw - 32px);padding:16px;border-radius:8px;font-size:13px;line-height:1.5;font-weight:500;background:#fff;color:hsl(0 0% 9%);border:1px solid hsl(0 0% 93%);box-shadow:0 4px 12px rgba(0,0,0,.1);transition:opacity .2s,transform .2s}" +
    ".dark .crispai-toast{background:#000;color:hsl(0 0% 99%);border-color:hsl(0 0% 20%)}" +
    ".crispai-toast[data-hidden=true]{opacity:0;transform:translate(-50%,-12px);pointer-events:none}" +
    ".crispai-toast svg{flex:none}";

  var ICON = {
    // 标签图标（耳麦），和其他标签一样是 1em 的单色图标
    support:
      '<svg class="crispai-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M19.5 19v.5a2.5 2.5 0 0 1-2.5 2.5h-3"/></svg>',
    chevron:
      '<svg aria-hidden="true" fill="none" focusable="false" height="1em" role="presentation" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="1em" class="' + "absolute end-3 w-4 h-4 transition-none" + '" style="pointer-events:none"><path d="m6 9 6 6 6-6"></path></svg>',
    success:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"></path></svg>',
    error:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"></path></svg>',
    logout:
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 8l4 4-4 4"/><path d="M20 12H10"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  function h(tag, className, props, children) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "text") el.textContent = value;
        else if (key === "html") el.innerHTML = value; // 只用于上面 ICON 里的固定图标
        else if (key.indexOf("on") === 0) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child) el.appendChild(child);
    });
    return el;
  }

  /** 后台的悬停/按下/键盘焦点效果是靠 data-* 属性触发的，这里给自己建的元素补上同样的属性 */
  function interactive(el, focusTarget) {
    var target = focusTarget || el;
    el.addEventListener("pointerenter", function () { el.setAttribute("data-hover", "true"); });
    el.addEventListener("pointerleave", function () { el.removeAttribute("data-hover"); el.removeAttribute("data-pressed"); });
    el.addEventListener("pointerdown", function () { el.setAttribute("data-pressed", "true"); });
    el.addEventListener("pointerup", function () { el.removeAttribute("data-pressed"); });
    target.addEventListener("focus", function () {
      if (target.matches(":focus-visible")) el.setAttribute("data-focus-visible", "true");
    });
    target.addEventListener("blur", function () { el.removeAttribute("data-focus-visible"); });
    return el;
  }

  function button(text, className, onClick, props) {
    var el = h("button", className, Object.assign({ type: "button", text: text }, props || {}));
    el.addEventListener("click", onClick);
    return interactive(el);
  }

  function labelBlock(title, description) {
    return h("div", CLS.label, null, [
      h("p", CLS.title, { text: title }),
      description ? h("p", CLS.desc, { text: description }) : null,
    ]);
  }

  var uid = 0;
  function nextId(prefix) { uid += 1; return "crispai-" + prefix + "-" + uid; }

  function textInput(props, widthClass) {
    var input = h("input", CLS.input, Object.assign({ type: "text", "data-slot": "input" }, props));
    var wrapper = h("div", CLS.inputWrapper, { "data-slot": "input-wrapper", style: "cursor:text" }, [
      h("div", CLS.inputInner, { "data-slot": "inner-wrapper" }, [input]),
    ]);
    var base = h("div", CLS.inputBase + " " + (widthClass || CLS.controlWidth), { "data-slot": "base" }, [wrapper]);
    wrapper.addEventListener("pointerenter", function () { wrapper.setAttribute("data-hover", "true"); });
    wrapper.addEventListener("pointerleave", function () { wrapper.removeAttribute("data-hover"); });
    wrapper.addEventListener("click", function () { input.focus(); });
    input.addEventListener("focus", function () { base.setAttribute("data-focus", "true"); });
    input.addEventListener("blur", function () { base.removeAttribute("data-focus"); });
    return { root: base, input: input };
  }

  function textArea(props) {
    var area = h("textarea", CLS.textarea, Object.assign({ "data-slot": "input", rows: "3" }, props));
    var wrapper = h("div", CLS.textareaWrapper, { "data-slot": "input-wrapper", style: "cursor:text" }, [
      h("div", CLS.textareaInner, { "data-slot": "inner-wrapper" }, [area]),
    ]);
    var base = h("div", "group flex flex-col data-[hidden=true]:hidden w-full", { "data-slot": "base" }, [wrapper]);
    wrapper.addEventListener("pointerenter", function () { wrapper.setAttribute("data-hover", "true"); });
    wrapper.addEventListener("pointerleave", function () { wrapper.removeAttribute("data-hover"); });
    area.addEventListener("focus", function () { base.setAttribute("data-focus", "true"); });
    area.addEventListener("blur", function () { base.removeAttribute("data-focus"); });
    return { root: base, input: area };
  }

  function select(options, props, widthClass) {
    var el = h("select", "crispai-select", props, options.map(function (option) {
      return h("option", null, { value: option[0], text: option[1] });
    }));
    var trigger = h("div", CLS.selectTrigger, { "data-slot": "trigger" }, [el]);
    trigger.insertAdjacentHTML("beforeend", ICON.chevron);
    trigger.addEventListener("pointerenter", function () { trigger.setAttribute("data-hover", "true"); });
    trigger.addEventListener("pointerleave", function () { trigger.removeAttribute("data-hover"); });
    el.addEventListener("focus", function () { trigger.setAttribute("data-focus", "true"); });
    el.addEventListener("blur", function () { trigger.removeAttribute("data-focus"); });
    var base = h("div", "group inline-flex flex-col relative transition-none " + (widthClass || CLS.controlWidth), { "data-slot": "base" }, [trigger]);
    return { root: base, input: el };
  }

  function toggle(labelId) {
    var input = h("input", CLS.switchInput, { type: "checkbox", role: "switch", "aria-labelledby": labelId });
    var label = h("label", CLS.switchLabel, null, [
      input,
      h("span", CLS.switchTrack, { "aria-hidden": "true" }, [h("span", CLS.switchThumb)]),
    ]);
    function sync() {
      if (input.checked) label.setAttribute("data-selected", "true");
      else label.removeAttribute("data-selected");
    }
    input.addEventListener("change", sync);
    interactive(label, input);
    return {
      root: label,
      input: input,
      set: function (value) { input.checked = !!value; sync(); },
    };
  }

  /** 一行设置：左边标题和说明，右边控件。和「基础设置」里的行一样 */
  function row(title, description, control, isSwitch) {
    return h("div", isSwitch ? CLS.rowSwitch : CLS.row, null, [labelBlock(title, description), control]);
  }
  function switchRow(title, description) {
    var id = nextId("label");
    var control = toggle(id);
    var block = labelBlock(title, description);
    block.firstChild.id = id;
    return { root: h("div", CLS.rowSwitch, null, [block, control.root]), control: control };
  }

  // ---------------------------------------------------------------------------
  // 提示（样式对齐后台的保存提示）
  // ---------------------------------------------------------------------------
  var toastEl, toastTimer;
  function toast(message, isError) {
    if (!toastEl) {
      toastEl = h("div", "crispai-toast", { role: "status", "aria-live": "polite", "data-hidden": "true" });
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = isError ? ICON.error : ICON.success;
    toastEl.appendChild(h("div", null, { text: message }));
    toastEl.setAttribute("data-type", isError ? "error" : "success");
    // 先让浏览器应用隐藏状态，再显示，才有淡入效果
    requestAnimationFrame(function () { toastEl.setAttribute("data-hidden", "false"); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.setAttribute("data-hidden", "true"); }, isError ? 5000 : 3000);
  }

  function api(path, data) {
    var options = { credentials: "same-origin", cache: "no-store" };
    if (data !== undefined) {
      options.method = "POST";
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(data);
    }
    return fetch("/api/v1" + path, options).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (result) {
        if (response.status === 401) {
          location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
          throw new Error("登录已失效，正在跳转登录页");
        }
        if (!result) throw new Error("服务返回了无效内容，请检查服务状态");
        if (!response.ok) throw new Error(result.message || "请求失败");
        return result;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 「客服接待」面板
  // ---------------------------------------------------------------------------
  var ACTIONS_OFFLINE = [
    ["none", "保持静默，仅转发给客服"],
    ["message", "发送工单 / 邮箱引导"],
    ["ai", "由 AI 接管"],
    ["rules", "关键词优先，未命中再由 AI 回复"],
  ];
  var ACTIONS_TIMEOUT = [
    ["none", "保持等待，不自动回复"],
    ["message", "发送工单 / 邮箱引导"],
    ["ai", "由 AI 接管"],
    ["rules", "关键词优先，未命中再由 AI 回复"],
  ];
  var DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  function buildPanel(projectId) {
    var loaded = null;
    var f = {};

    // ---- 顶部
    var statusChips = h("div", "flex flex-wrap gap-2");
    var saveButton = button("保存设置", CLS.buttonSolid, save);
    var header = h("div", CLS.cardHeader, null, [
      h("span", null, { text: "客服在线时人工优先接待；离线或等待超时后，按下面的设置自动处理" }),
      h("div", CLS.headerActions, null, [saveButton]),
    ]);

    // ---- 在线状态
    var enabled = switchRow("是否启用客服接待策略", "启用后在线时由人工优先接待。关闭则保持项目原有的关键词和 AI 回复流程");
    f.enabled = enabled.control;

    f.mode = select([["manual", "手动切换"], ["schedule", "按营业时间自动切换"]], { "aria-label": "切换方式" });
    f.online = select([["true", "在线 · 人工优先"], ["false", "离线 · 执行离线动作"]], { "aria-label": "当前状态" });
    var onlineLine = h("div", CLS.groupLineNext, null, [
      labelBlock("当前状态", "也可以在 Telegram 客服群里发送 /online、/offline 切换"),
      f.online.root,
    ]);

    f.days = [];
    var days = h("div", "crispai-days", { role: "group", "aria-label": "营业日" }, DAYS.map(function (name, index) {
      var chip = h("button", CLS.chip + " crispai-day", { type: "button", "aria-pressed": "false", "data-day": String(index + 1) }, [
        h("span", CLS.chipText, { text: name }),
      ]);
      chip.addEventListener("click", function () {
        chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
      });
      f.days.push(chip);
      return chip;
    }));
    f.start = textInput({ type: "time", "aria-label": "开始时间", required: true }, "w-full");
    f.end = textInput({ type: "time", "aria-label": "结束时间", required: true }, "w-full");
    f.timezone = textInput({ "aria-label": "时区", placeholder: "Asia/Shanghai", spellcheck: "false" });
    var scheduleLines = h("div", "w-full", null, [
      h("div", CLS.groupLineNext, null, [labelBlock("营业日", "按开始时间所在的日期计算"), days]),
      h("div", CLS.groupLineNext, null, [
        labelBlock("营业时间", "支持跨午夜，例如 22:00 到次日 06:00"),
        h("div", "crispai-inline crispai-range", null, [f.start.root, h("span", CLS.desc, { text: "至" }), f.end.root]),
      ]),
      h("div", CLS.groupLineNext, null, [
        labelBlock("时区", "使用 IANA 时区名称。Telegram 里发送 /auto 可恢复按营业时间切换"),
        f.timezone.root,
      ]),
    ]);
    var availability = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [labelBlock("在线状态切换方式", "手动切换，或按营业日和时段自动切换"), f.mode.root]),
      onlineLine,
      scheduleLines,
    ]);

    // ---- 离线
    f.offlineAction = select(ACTIONS_OFFLINE, { "aria-label": "离线动作" });
    f.offlineMessage = textArea({ maxlength: "4000", "aria-label": "离线自动回复内容", placeholder: "例如：客服当前离线，请通过 https://… 提交工单，或发送邮件至 support@example.com" });
    var offlineMessageLine = h("div", "w-full mt-3", null, [f.offlineMessage.root]);
    var offline = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [
        labelBlock("离线时客户发来消息", "AI 接管需要先在「智能回复」里开启 AI。引导消息对同一会话最多每 60 秒发送一次"),
        f.offlineAction.root,
      ]),
      offlineMessageLine,
    ]);

    // ---- 超时
    var timeoutEnabled = switchRow("是否启用等待超时接管", "从第一条没有得到人工回复的消息开始计时，连续追问不会延长等待；人工回复会取消本轮等待");
    f.timeoutEnabled = timeoutEnabled.control;
    f.timeoutValue = textInput({ type: "number", min: "1", max: "86400", step: "1", inputmode: "numeric", "aria-label": "等待时长" }, "w-full");
    f.timeoutUnit = select([["1", "秒"], ["60", "分钟"]], { "aria-label": "时间单位" }, "shrink-0 crispai-unit");
    f.timeoutAction = select(ACTIONS_TIMEOUT, { "aria-label": "超时动作" });
    f.timeoutMessage = textArea({ maxlength: "4000", "aria-label": "超时自动回复内容", placeholder: "例如：抱歉让您久等了，请通过以下工单入口或邮箱联系我们…" });
    var timeoutMessageLine = h("div", "w-full mt-3", null, [f.timeoutMessage.root]);
    var timeout = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [
        labelBlock("等待时长", "可设置 1 秒至 24 小时"),
        h("div", "crispai-inline " + CLS.controlWidth, null, [f.timeoutValue.root, f.timeoutUnit.root]),
      ]),
      h("div", CLS.groupLineNext, null, [
        labelBlock("超时后的动作", "接管后客服仍可随时人工回复继续接待"),
        f.timeoutAction.root,
      ]),
      timeoutMessageLine,
    ]);

    // ---- 屏蔽
    var abuseEnabled = switchRow("是否启用消息频率限制", "同一会话在统计窗口内超过允许数量即自动屏蔽，不再转发到 Telegram，也不触发自动回复");
    f.abuseEnabled = abuseEnabled.control;
    f.abuseWindow = textInput({ type: "number", min: "1", max: "3600", step: "1", inputmode: "numeric", "aria-label": "统计窗口（秒）" });
    f.abuseMax = textInput({ type: "number", min: "2", max: "1000", step: "1", inputmode: "numeric", "aria-label": "窗口内允许的消息数" });
    var abuse = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [labelBlock("统计窗口", "单位：秒，1 至 3600"), f.abuseWindow.root]),
      h("div", CLS.groupLineNext, null, [labelBlock("窗口内允许的消息数", "超过这个数量就屏蔽，2 至 1000"), f.abuseMax.root]),
    ]);

    var blockedList = h("div", "crispai-list", { "aria-live": "polite" });
    var refreshButton = button("刷新", CLS.buttonBorderedSmall, function () {
      loadBlocked().catch(function (error) { toast(error.message, true); });
    });
    var blocked = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [
        labelBlock("已屏蔽会话", "屏蔽记录独立保留，清理旧会话不会解除。解除后只恢复接收新的消息"),
        refreshButton,
      ]),
      blockedList,
    ]);

    f.blockSession = textInput({ maxlength: "256", "aria-label": "Crisp 会话 ID", placeholder: "session_… 或不带前缀的 ID", spellcheck: "false" }, "w-full");
    f.blockReason = textInput({ maxlength: "500", "aria-label": "屏蔽原因", placeholder: "屏蔽原因（可选）" }, "w-full");
    var blockButton = button("屏蔽", CLS.buttonDanger, blockManually);
    var manualBlock = h("div", CLS.group, null, [
      h("div", CLS.groupLine, null, [
        labelBlock("手动屏蔽会话", "屏蔽以 Crisp 会话为单位；客户创建新会话后需要另行处理"),
      ]),
      h("div", "crispai-inline mt-3", { style: "flex-wrap:wrap;width:100%" }, [
        h("div", null, { style: "flex:2 1 14rem" }, [f.blockSession.root]),
        h("div", null, { style: "flex:2 1 14rem" }, [f.blockReason.root]),
        blockButton,
      ]),
    ]);

    var statusRow = h("div", CLS.row, null, [labelBlock("当前状态", "保存后立即生效，并取消之前尚未执行的等待任务"), statusChips]);
    var body = h("div", CLS.cardBody, null, [
      statusRow,
      enabled.root,
      availability,
      h("p", "crispai-section", { text: "离线时" }),
      offline,
      h("p", "crispai-section", { text: "人工未回复时" }),
      timeoutEnabled.root,
      timeout,
      h("p", "crispai-section", { text: "刷屏与屏蔽" }),
      abuseEnabled.root,
      abuse,
      blocked,
      manualBlock,
    ]);
    var card = h("div", CLS.card, null, [header, body]);
    var panel = h("div", CLS.panel, {
      role: "tabpanel", "data-slot": "panel", "data-crispai-panel": "", id: "crispai-support-panel",
      "aria-labelledby": "crispai-support-tab", tabindex: "0", hidden: true,
    }, [card]);

    // ---- 行为
    function chip(text) {
      return h("div", CLS.chip, null, [h("span", CLS.chipText, { text: text })]);
    }
    function showStatus(data) {
      statusChips.replaceChildren(
        chip(data.support.enabled ? (data.currentOnline ? "在线" : "离线") : "策略未启用"),
        chip(data.support.availabilityMode === "schedule" ? "按营业时间" : "手动切换"),
        chip("AI " + (data.enableAI ? "已开启" : "未开启")),
        chip("关键词" + (data.enableKeyword ? "已开启" : "未开启")),
      );
    }
    function updateVisibility() {
      var scheduled = f.mode.input.value === "schedule";
      scheduleLines.hidden = !scheduled;
      onlineLine.hidden = scheduled;
      offlineMessageLine.hidden = !/^(message|rules)$/.test(f.offlineAction.input.value);
      timeoutMessageLine.hidden = !/^(message|rules)$/.test(f.timeoutAction.input.value);
    }
    [f.mode, f.offlineAction, f.timeoutAction].forEach(function (control) {
      control.input.addEventListener("change", updateVisibility);
    });

    function show(data) {
      loaded = data;
      var config = data.support;
      f.enabled.set(config.enabled);
      f.mode.input.value = config.availabilityMode;
      f.online.input.value = String(config.online);
      f.start.input.value = config.schedule.start;
      f.end.input.value = config.schedule.end;
      f.timezone.input.value = config.schedule.timezone;
      f.days.forEach(function (day) {
        day.setAttribute("aria-pressed", String(config.schedule.days.indexOf(Number(day.getAttribute("data-day"))) !== -1));
      });
      f.offlineAction.input.value = config.offline.action;
      f.offlineMessage.input.value = config.offline.message;
      f.timeoutEnabled.set(config.timeout.enabled);
      var inMinutes = config.timeout.seconds % 60 === 0;
      f.timeoutUnit.input.value = inMinutes ? "60" : "1";
      f.timeoutValue.input.value = String(config.timeout.seconds / (inMinutes ? 60 : 1));
      f.timeoutAction.input.value = config.timeout.action;
      f.timeoutMessage.input.value = config.timeout.message;
      f.abuseEnabled.set(config.abuse.enabled);
      f.abuseWindow.input.value = String(config.abuse.windowSeconds);
      f.abuseMax.input.value = String(config.abuse.maxMessages);
      showStatus(data);
      updateVisibility();
    }
    function read() {
      return {
        enabled: f.enabled.input.checked,
        online: f.online.input.value === "true",
        availabilityMode: f.mode.input.value,
        schedule: {
          timezone: f.timezone.input.value.trim(),
          days: f.days.filter(function (day) { return day.getAttribute("aria-pressed") === "true"; })
            .map(function (day) { return Number(day.getAttribute("data-day")); }),
          start: f.start.input.value,
          end: f.end.input.value,
        },
        offline: { action: f.offlineAction.input.value, message: f.offlineMessage.input.value.trim() },
        timeout: {
          enabled: f.timeoutEnabled.input.checked,
          seconds: Number(f.timeoutValue.input.value) * Number(f.timeoutUnit.input.value),
          action: f.timeoutAction.input.value,
          message: f.timeoutMessage.input.value.trim(),
        },
        abuse: {
          enabled: f.abuseEnabled.input.checked,
          windowSeconds: Number(f.abuseWindow.input.value),
          maxMessages: Number(f.abuseMax.input.value),
        },
      };
    }

    function save() {
      if (!loaded || saveButton.disabled) return;
      var config = read();
      if (!Number.isInteger(config.timeout.seconds) || config.timeout.seconds < 1 || config.timeout.seconds > 86400) {
        toast("等待时长应为 1 秒至 24 小时的整数秒", true); return;
      }
      if (!config.schedule.days.length) { toast("请至少选择一个营业日", true); return; }
      if (config.schedule.start === config.schedule.end) { toast("营业开始和结束时间不能相同", true); return; }
      saveButton.disabled = true;
      api("/support", { project_id: projectId, support: config }).then(function (result) {
        loaded = Object.assign({}, loaded, { support: result.data, currentOnline: result.currentOnline });
        showStatus(loaded);
        toast("保存成功");
      }).catch(function (error) {
        toast(error.message, true);
      }).then(function () { saveButton.disabled = false; });
    }

    function loadBlocked() {
      return api("/support/blocked?project_id=" + encodeURIComponent(projectId)).then(function (result) {
        blockedList.replaceChildren();
        if (!result.data.length) {
          blockedList.appendChild(h("p", CLS.desc, { text: "暂无屏蔽会话" }));
          return;
        }
        result.data.forEach(function (entry) {
          var unblock = button("解除屏蔽", CLS.buttonBorderedSmall, function () {
            unblock.disabled = true;
            api("/support/unblock", { project_id: projectId, session_id: entry.session_id }).then(function () {
              toast("已解除屏蔽");
              return loadBlocked();
            }).catch(function (error) { toast(error.message, true); unblock.disabled = false; });
          });
          var detail = [
            entry.source === "abuse" ? "自动屏蔽" : "人工屏蔽",
            new Date(entry.created_at).toLocaleString("zh-CN"),
            entry.reason || "",
          ].filter(Boolean).join(" · ");
          blockedList.appendChild(h("div", "crispai-item", null, [
            h("div", "crispai-item-main", null, [
              h("code", CLS.code, { text: entry.session_id }),
              h("p", CLS.desc, { text: detail }),
            ]),
            unblock,
          ]));
        });
      });
    }

    function blockManually() {
      var sessionId = f.blockSession.input.value.trim();
      if (!sessionId) { toast("请填写会话 ID", true); f.blockSession.input.focus(); return; }
      blockButton.disabled = true;
      api("/support/block", {
        project_id: projectId, session_id: sessionId, reason: f.blockReason.input.value.trim(),
      }).then(function () {
        toast("已屏蔽此会话");
        f.blockSession.input.value = "";
        f.blockReason.input.value = "";
        return loadBlocked();
      }).catch(function (error) { toast(error.message, true); })
        .then(function () { blockButton.disabled = false; });
    }

    var started = false;
    function load() {
      if (started) return;
      started = true;
      saveButton.disabled = true;
      api("/support?project_id=" + encodeURIComponent(projectId)).then(function (result) {
        show(result.data);
        saveButton.disabled = false;
        return loadBlocked();
      }).catch(function (error) {
        started = false;
        toast(error.message, true);
      });
    }

    updateVisibility();
    return { root: panel, load: load };
  }

  // ---------------------------------------------------------------------------
  // 把标签和面板接进项目管理页
  // ---------------------------------------------------------------------------
  var HASH = "#support";
  var mounted = null; // { tablist, container, tab, panel, projectId, active }

  function currentProjectId() {
    return new URLSearchParams(location.search).get("id") || "";
  }

  /**
   * 选中底色（那块白色圆角）是后台自己的一个元素，由后台按它认为选中的标签摆放。
   * 我们的标签选中时把它挪到我们的标签下面；标签栏多了一个标签后各标签变窄，也要按新宽度校正。
   * 只在位置确实不对时才改，避免和后台互相触发。
   */
  function syncCursor() {
    if (!mounted) return;
    var tablist = mounted.tablist;
    var cursor = tablist.querySelector("[data-slot=cursor]");
    var selected = mounted.active ? mounted.tab : tablist.querySelector("[role=tab][aria-selected=true]:not([data-crispai-tab])");
    if (!cursor || !selected) return;
    if (mounted.cursor !== cursor) {
      // 后台在窗口大小变化等时机会把底色摆回它自己的选中标签，盯着它的位置变化随时校正
      if (mounted.cursorObserver) mounted.cursorObserver.disconnect();
      mounted.cursor = cursor;
      mounted.cursorObserver = new MutationObserver(syncCursor);
      mounted.cursorObserver.observe(cursor, { attributes: true, attributeFilter: ["style"] });
    }
    var want = {
      left: selected.offsetLeft + "px", top: selected.offsetTop + "px",
      width: selected.offsetWidth + "px", height: selected.offsetHeight + "px",
    };
    Object.keys(want).forEach(function (key) {
      if (cursor.style[key] !== want[key]) cursor.style[key] = want[key];
    });
  }

  function setActive(active) {
    if (!mounted || mounted.active === active) { syncCursor(); return; }
    mounted.active = active;
    var tab = mounted.tab;
    if (active) {
      mounted.container.setAttribute("data-crispai-active", "");
      tab.setAttribute("data-selected", "true");
      tab.setAttribute("aria-selected", "true");
      mounted.panel.root.hidden = false;
      mounted.panel.load();
      if (location.hash !== HASH) history.replaceState(history.state, "", location.pathname + location.search + HASH);
    } else {
      mounted.container.removeAttribute("data-crispai-active");
      tab.removeAttribute("data-selected");
      tab.setAttribute("aria-selected", "false");
      mounted.panel.root.hidden = true;
      if (location.hash === HASH) history.replaceState(history.state, "", location.pathname + location.search);
    }
    syncCursor();
  }

  function mountSupportTab() {
    var onProjectPage = /^\/dashboard\/project\/?$/.test(location.pathname);
    var tablist = onProjectPage ? document.querySelector('[role="tablist"]') : null;
    var template = tablist && tablist.querySelector('[role="tab"][data-key="general"]');
    var projectId = currentProjectId();

    // 离开了项目页，或者换了项目、页面重新渲染了：丢掉旧的
    if (mounted && (!template || mounted.tablist !== tablist || mounted.projectId !== projectId || !mounted.tab.isConnected)) {
      mounted.tab.remove();
      mounted.panel.root.remove();
      if (mounted.container.isConnected) mounted.container.removeAttribute("data-crispai-active");
      mounted.resize.disconnect();
      if (mounted.cursorObserver) mounted.cursorObserver.disconnect();
      mounted = null;
    }
    if (!template || !projectId) return;
    if (mounted) return;

    // 标签栏所在的容器：里面依次是标签栏和当前标签的面板
    var base = tablist.parentElement;
    var container = base && base.parentElement;
    if (!container) return;

    // 以现有的未选中标签为模板，样式和结构保持一致
    var tab = template.cloneNode(true);
    ["id", "aria-controls", "data-collection", "data-selected", "data-hover-unselected", "data-focus-visible", "data-pressed"].forEach(function (name) {
      tab.removeAttribute(name);
    });
    tab.setAttribute("data-key", "support");
    tab.setAttribute("data-crispai-tab", "");
    tab.setAttribute("id", "crispai-support-tab");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-controls", "crispai-support-panel");
    tab.setAttribute("tabindex", "0");
    var spans = tab.querySelectorAll("[data-slot=tabContent] span");
    if (spans.length >= 2) {
      spans[0].innerHTML = ICON.support;
      spans[spans.length - 1].textContent = "客服接待";
    } else {
      tab.textContent = "客服接待";
    }
    tab.addEventListener("pointerenter", function () {
      if (!mounted || !mounted.active) tab.setAttribute("data-hover-unselected", "true");
    });
    tab.addEventListener("pointerleave", function () { tab.removeAttribute("data-hover-unselected"); });
    tab.addEventListener("focus", function () {
      if (tab.matches(":focus-visible")) tab.setAttribute("data-focus-visible", "true");
    });
    tab.addEventListener("blur", function () { tab.removeAttribute("data-focus-visible"); });
    tab.addEventListener("click", function () { tab.removeAttribute("data-hover-unselected"); setActive(true); });

    var panel = buildPanel(projectId);
    tablist.appendChild(tab);
    container.appendChild(panel.root);

    var resize = new ResizeObserver(syncCursor);
    resize.observe(tablist);
    mounted = { tablist: tablist, container: container, tab: tab, panel: panel, projectId: projectId, active: false, resize: resize };

    // 点了后台原有的标签：收起我们的面板，把选中效果还给它
    tablist.addEventListener("click", function (event) {
      var clicked = event.target.closest && event.target.closest('[role="tab"]');
      if (clicked && clicked !== tab && mounted && mounted.tablist === tablist) {
        setActive(false);
        // 后台自己切换标签后会重新摆放选中底色，等它摆完再按新布局校正一次
        setTimeout(syncCursor, 0);
        setTimeout(syncCursor, 300);
      }
    }, true);

    if (location.hash === HASH) setActive(true);
    else syncCursor();
  }

  // ---------------------------------------------------------------------------
  // 顶栏的「退出登录」按钮
  // ---------------------------------------------------------------------------
  function mountLogout() {
    if (document.querySelector("[data-crispai-logout]")) return;
    var buttons = document.querySelectorAll("nav header ul li button");
    var template = buttons[buttons.length - 1];
    if (!template || !template.parentElement || template.parentElement.tagName !== "LI") return;
    var item = template.parentElement.cloneNode(false);
    var logout = template.cloneNode(false);
    ["id", "aria-haspopup", "aria-expanded", "aria-controls", "data-slot", "data-hover", "data-pressed", "data-focus-visible"].forEach(function (name) {
      logout.removeAttribute(name);
    });
    logout.setAttribute("data-crispai-logout", "");
    logout.setAttribute("type", "button");
    logout.setAttribute("aria-label", "退出登录");
    logout.setAttribute("title", "退出登录");
    logout.innerHTML = ICON.logout;
    interactive(logout);
    logout.addEventListener("click", function () {
      if (logout.disabled) return;
      logout.disabled = true;
      fetch("/api/v1/logout", { method: "POST", credentials: "same-origin" }).then(function (response) {
        if (!response.ok) throw new Error("退出失败");
        location.href = "/login";
      }).catch(function () {
        logout.disabled = false;
        location.href = "/logout";
      });
    });
    item.appendChild(logout);
    template.parentElement.parentElement.appendChild(item);
  }

  // ---------------------------------------------------------------------------
  // 启动：后台是单页应用，页面切换不会重新加载，所以一直观察页面变化
  // ---------------------------------------------------------------------------
  var style = document.createElement("style");
  style.setAttribute("data-crispai", "");
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);

  var scheduled = false;
  function refresh() {
    scheduled = false;
    try {
      mountSupportTab();
      mountLogout();
    } catch (error) {
      // 页面结构和预期不一致时不影响后台其余功能
      if (window.console) console.warn("[CrispAI] dashboard extras skipped:", error);
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", function () {
    if (mounted) setActive(location.hash === HASH);
  });
  schedule();
})();
