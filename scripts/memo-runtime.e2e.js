// Failure modes: repeated Enter, lost next draft, stale selection, literal Markdown, hidden active filters.
// Run in Obsidian eval. Uses isolated DOM and a delayed in-memory capture; never writes user notes.
(async () => {
  const plugin = app.plugins.plugins['crisp-pulse'];
  let leaf = app.workspace.getLeavesOfType('crisp-pulse-memo-view')[0];
  if (!leaf) { await plugin.activateMemoView(); leaf = app.workspace.getLeavesOfType('crisp-pulse-memo-view')[0]; }
  // A background tab holds a deferred placeholder until it is loaded.
  await leaf.loadIfDeferred?.();
  const real = leaf.view;
  const H = plugin.constructor.memoHelpers;
  const results = {};
  const originalFocus = document.activeElement;
  const tick = () => new Promise(r => setTimeout(r, 30));
  const fixtures = [];const views=[];
  function fixture(capture) {
    const v = Object.create(real);
    const container = document.createElement('div');
    container.createDiv(); const root = container.createDiv({cls:'crisp-pulse-memo-view'});
    Object.defineProperty(v, 'containerEl', {value:container, configurable:true});
    v.plugin = {settings:{...plugin.settings}, memoStore:{capture, anksTopics:()=>['a','b']}};
    v.mode='general'; v.draft=''; v.memoSubmitting=false; v.draftRevision=0; v.memoMarkdownComponents=new Map(); v.memos=[];v.tab='all';v.index=null;v.error=null;v.expanded=null;v.resetFilters();
    v.reload=async()=>{root.empty();v.renderComposer(root,false);};
    v.renderComposer(root,false); fixtures.push(container);views.push(v);
    return {v,root,input:root.querySelector('textarea')};
  }
  const enter = input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  const type = (input,text)=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));};
  try {
    let writes=[];let resolve;
    let gate=new Promise(r=>resolve=r);
    let f=fixture(async text=>{writes.push(text);await gate;});
    type(f.input,'第一条');enter(f.input);enter(f.input);
    results.repeatEnter={captureCalls:writes.length,values:[...writes],sendDisabled:f.root.querySelector('.crisp-pulse-memo-send').disabled};
    resolve();await tick();
    writes=[];gate=new Promise(r=>resolve=r);
    f=fixture(async text=>{writes.push(text);await gate;});
    type(f.input,'第一条');enter(f.input);type(f.input,'下一条尚未提交的想法');
    results.typingDuringSave={draftBeforeResolve:f.v.draft,savedValues:[...writes]};
    resolve();await tick();
    Object.assign(results.typingDuringSave,{draftAfterResolve:f.v.draft,inputAfterResolve:f.root.querySelector('textarea').value});
    f=fixture(async()=>{});
    const m={path:'Daily/2026-10-08.md',date:'2026-10-08',time:'09:00',startLine:0,text:'**重点**\n- 第一项\n[[已有笔记]] #阅读',tags:['阅读'],links:[]};
    f.v.renderMemoCard(f.root,m);
    const card=f.root.querySelector('.crisp-pulse-memo-text');
    await tick();
    results.markdownCard={text:card.textContent,boldElements:card.querySelectorAll('strong,b').length,listElements:card.querySelectorAll('li').length,noteLinks:card.querySelectorAll('a.internal-link').length};
    f=fixture(async()=>{});
    type(f.input,'甲乙丙丁戊'); f.input.setSelectionRange(1,3);
    // A mounted isolated DOM host is needed to exercise focus/selection restoration.
    f.v.containerEl.style.cssText='position:fixed;left:-10000px;top:0;width:300px';document.body.append(f.v.containerEl);
    f.input.focus();f.input.setSelectionRange(1,3);
    f.v.render();await tick();
    const next=f.root.querySelector('textarea');
    results.composerSelectionAfterRender={expected:[1,3],actual:[next.selectionStart,next.selectionEnd],draft:next.value};
    const nav=real.containerEl.querySelector('.crisp-pulse-memo-nav');
    results.liveGeometry={width:real.containerEl.getBoundingClientRect().width,composer:real.containerEl.querySelector('.crisp-pulse-memo-composer').getBoundingClientRect().toJSON(),stats:real.containerEl.querySelector('.crisp-pulse-memo-stats').getBoundingClientRect().toJSON(),tabs:real.containerEl.querySelector('.crisp-pulse-memo-tabs').getBoundingClientRect().toJSON(),navCollapsedByTheme:document.body.classList.contains('still-quiet-nav')};
    const filtered=fixture(async()=>{});filtered.v.filters.from='2026-10-01';filtered.v.filters.excludeTags=['工作'];filtered.v.render();
    results.hiddenFilters={chips:filtered.v.activeChips.textContent,active:filtered.root.querySelector('[aria-label="高级筛选"]').classList.contains('is-active')};
    const checks={
      singleSubmit:results.repeatEnter.captureCalls===1,
      preservesNextDraft:results.typingDuringSave.draftAfterResolve==='下一条尚未提交的想法',
      rendersMarkdown:results.markdownCard.boldElements===1 && results.markdownCard.listElements===1 && results.markdownCard.noteLinks===1,
      restoresSelection:JSON.stringify(results.composerSelectionAfterRender.actual)==='[1,3]',
      exposesHiddenFilters:results.hiddenFilters.active && results.hiddenFilters.chips.includes('2026-10-01') && results.hiddenFilters.chips.includes('工作')
    };
    return JSON.stringify({passed:Object.values(checks).every(Boolean),checks,results});
  } finally {for(const v of views)v.clearMemoMarkdown?.();for(const el of fixtures)el.remove();if(originalFocus?.isConnected) originalFocus.focus({preventScroll:true});}
})()
