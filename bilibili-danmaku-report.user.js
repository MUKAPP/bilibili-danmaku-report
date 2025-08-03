// ==UserScript==
// @name         Bilibili 弹幕批量举报
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在B站视频页左下角添加一个悬浮的“批量举报”按钮，获取全部弹幕，并直接调用API进行举报。支持UI配置规则、暂停恢复、智能处理频繁操作。
// @author       MUKAPP
// @match        *://www.bilibili.com/video/*
// @updateURL    https://cdn.jsdelivr.net/gh/MUKAPP/bilibili-danmaku-report/bilibili-danmaku-report.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/MUKAPP/bilibili-danmaku-report/bilibili-danmaku-report.user.js
// @supportURL   https://github.com/MUKAPP/bilibili-danmaku-report
// @require      https://cdn.jsdelivr.net/npm/protobufjs@7.2.5/dist/protobuf.min.js
// @require      https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // --- 全局状态变量 ---
    let reportState = 'idle'; // idle, fetching, running, paused, done
    let commentsToReport = [];
    let currentIndex = 0;
    const baseCooldown = 2000; // 基础举报间隔 (ms)
    let reportConfig = []; // 规则配置将从存储中加载

    // --- 默认规则配置 ---
    const defaultConfig = [
        { keywords: ['停止氪金', '我曾三度调香', '忠诚！', '散艾', '散草'], reason: 9 },
        { keywords: ['勇者大人', '散兵夫人', '皮套'], reason: 7 },
        { keywords: ['星怒', '星努', '兴努'], reason: 2 },
    ];
    const reasonMap = {
        1: '违法违禁', 2: '色情低俗', 9: '恶意刷屏', 3: '赌博诈骗', 4: '人身攻击',
        5: '侵犯隐私', 6: '垃圾广告', 10: '视频无关', 7: '引战', 8: '剧透',
        12: '青少年不良信息', 11: '其它', 13: '违法信息外链'
    };


    // --- WBI 签名实现 ---
    const mixinKeyEncTab = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
        33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
        61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
        36, 20, 34, 44, 16
    ];
    let wbiCache = null;

    async function getWbiKeys() {
        if (wbiCache && wbiCache.expire > Date.now()) return wbiCache.keys;
        const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
        const json = await response.json();
        if (json.code !== 0) throw new Error('获取WBI密钥失败: ' + json.message);
        const imgUrl = json.data.wbi_img.img_url;
        const subUrl = json.data.wbi_img.sub_url;
        const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0];
        const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0];
        const keys = { imgKey, subKey };
        wbiCache = { keys, expire: Date.now() + 600000 };
        return keys;
    }

    function getMixinKey(orig) {
        let temp = '';
        mixinKeyEncTab.forEach((i) => { if (orig[i]) temp += orig[i]; });
        return temp.slice(0, 32);
    }

    async function signRequest(params) {
        const wbiKeys = await getWbiKeys();
        const mixinKey = getMixinKey(wbiKeys.imgKey + wbiKeys.subKey);
        const currTime = Math.round(Date.now() / 1000);
        const wbiParams = { ...params, wts: currTime };
        const query = Object.keys(wbiParams).sort().map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(wbiParams[key])}`).join('&');
        const w_rid = CryptoJS.MD5(query + mixinKey).toString();
        return { ...wbiParams, w_rid };
    }
    // --- WBI 签名结束 ---

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    function getVideoInfo() {
        return new Promise((resolve) => {
            const eventListener = (event) => {
                window.removeEventListener('BiliReportVideoInfoEvent', eventListener);
                resolve(event.detail);
            };
            window.addEventListener('BiliReportVideoInfoEvent', eventListener);

            const script = document.createElement('script');
            script.textContent = `
                try {
                    let videoInfo = null;
                    if (window.__INITIAL_STATE__) {
                        const initialState = window.__INITIAL_STATE__;
                        if (initialState.aid && initialState.cid) {
                            videoInfo = { aid: initialState.aid, cid: initialState.cid };
                        }
                    }
                    window.dispatchEvent(new CustomEvent('BiliReportVideoInfoEvent', { detail: videoInfo }));
                } catch (e) {
                    window.dispatchEvent(new CustomEvent('BiliReportVideoInfoEvent', { detail: null }));
                }
                document.currentScript.remove();
            `;
            document.head.appendChild(script);
        });
    }


    function getCsrfToken() {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.startsWith('bili_jct=')) return cookie.substring('bili_jct='.length);
        }
        return null;
    }

    function logToUI(message, type = 'info') {
        const logContent = document.getElementById('report-log-content');
        if (!logContent) return;
        const p = document.createElement('p');
        p.innerHTML = `[${new Date().toLocaleTimeString()}] ${message}`;
        p.className = `log-${type}`;
        logContent.appendChild(p);
        logContent.scrollTop = logContent.scrollHeight;
    }

    async function processReportQueue() {
        const startButton = document.getElementById('start-report-btn');
        const videoInfo = await getVideoInfo();
        const csrf = getCsrfToken();

        while (currentIndex < commentsToReport.length) {
            if (reportState === 'paused') { await sleep(500); continue; }

            reportState = 'running';
            const item = commentsToReport[currentIndex];
            startButton.textContent = `暂停举报 (${currentIndex + 1}/${commentsToReport.length})`;
            logToUI(`正在举报: "<b>${item.text}</b>" (理由: ${reasonMap[item.reason] || '未知'})`);

            let success = false;
            let retries = 0;
            const maxRetries = 5;
            let retryCooldown = baseCooldown;

            while (retries < maxRetries && !success) {
                if (reportState === 'paused') { await sleep(500); continue; }

                const formData = new URLSearchParams();
                formData.append('cid', videoInfo.cid);
                formData.append('dmid', item.dmid);
                formData.append('reason', item.reason);
                formData.append('csrf', csrf);

                try {
                    const response = await fetch('https://api.bilibili.com/x/dm/report/add', {
                        method: 'POST', body: formData, credentials: 'include'
                    });
                    const result = await response.json();

                    if (result.code === 0) {
                        logToUI(`成功: "<b>${item.text}</b>"`, 'success');
                        success = true;
                    } else if (result.message.includes('过于频繁')) {
                        retries++;
                        retryCooldown += 2000;
                        logToUI(`操作频繁: "<b>${item.text}</b>"，将在 ${retryCooldown / 1000}s 后重试 (${retries}/${maxRetries})...`, 'warn');
                        await sleep(retryCooldown);
                        if (reportState === 'paused') break;
                    } else {
                        logToUI(`失败: "<b>${item.text}</b>" - ${result.message}`, 'error');
                        await sleep(3000);
                        break;
                    }
                } catch (e) {
                    logToUI(`网络错误: "<b>${item.text}</b>" - ${e.message}`, 'error');
                    break;
                }
            }

            if (reportState === 'paused') continue;

            if (!success && retries >= maxRetries) {
                logToUI(`重试 ${maxRetries} 次后依然操作频繁，<b>自动暂停举报</b>。请稍后手动继续。`, 'error');
                reportState = 'paused';
                startButton.textContent = `继续举报 (${currentIndex + 1}/${commentsToReport.length})`;
                return;
            }

            currentIndex++;
            await sleep(baseCooldown);
        }

        if (reportState !== 'paused') {
            reportState = 'done';
            startButton.textContent = '任务完成';
            startButton.disabled = true;
            logToUI(`<b>全部任务完成！</b>共处理 ${commentsToReport.length} 条弹幕。`, 'success');
        }
    }

    async function startNewTask() {
        const startButton = document.getElementById('start-report-btn');
        startButton.disabled = true;
        reportState = 'fetching';
        logToUI('<b>开始任务...</b>');

        const videoInfo = await getVideoInfo();
        if (!videoInfo) {
            logToUI('错误：无法获取视频信息 (aid/cid)，请刷新页面重试。', 'error');
            reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return;
        }

        const csrf = getCsrfToken();
        if (!csrf) { logToUI('错误：无法获取 CSRF token，请确保您已登录', 'error'); reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return; }

        logToUI(`获取到视频信息: cid=${videoInfo.cid}`);
        logToUI('正在获取WBI密钥...');

        try { await getWbiKeys(); }
        catch (error) { logToUI('错误：' + error.message, 'error'); reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return; }
        logToUI('密钥获取成功', 'success');

        let allDanmaku = [];
        try {
            const proto = `
                syntax = "proto3";
                message DanmakuElem {
                    int64 id = 1; int32 progress = 2; int32 mode = 3; int32 fontsize = 4;
                    uint32 color = 5; string midHash = 6; string content = 7; int64 ctime = 8;
                    int32 weight = 9; string action = 10; int32 pool = 11; string idStr = 12; int32 attr = 13;
                }
                message DanmakuSeg { repeated DanmakuElem elems = 1; }
            `;
            const root = protobuf.parse(proto, { keepCase: true }).root;
            const DanmakuSeg = root.lookupType("DanmakuSeg");

            for (let i = 1; i < 20; i++) {
                logToUI(`正在获取弹幕分段 (${i})...`);
                const signedParams = await signRequest({ type: 1, oid: videoInfo.cid, pid: videoInfo.aid, segment_index: i });
                const query = new URLSearchParams(signedParams).toString();
                const url = `https://api.bilibili.com/x/v2/dm/wbi/web/seg.so?${query}`;
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) { logToUI(`获取分段 ${i} 失败，状态码: ${response.status}`, 'warn'); break; }
                const buffer = await response.arrayBuffer();
                if (buffer.byteLength < 10) { logToUI(`分段 ${i} 为空，弹幕加载完毕。`, 'success'); break; }
                const decoded = DanmakuSeg.decode(new Uint8Array(buffer));
                allDanmaku.push(...decoded.elems);
            }
        } catch (error) {
            logToUI(`获取或解析弹幕列表失败: ${error.message}`, 'error');
            reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return;
        }

        logToUI(`获取到 ${allDanmaku.length} 条弹幕，开始筛选...`);
        const reportedDmids = new Set();
        commentsToReport = [];
        allDanmaku.forEach(dm => {
            const commentText = dm.content.trim();
            const dmid = dm.idStr;
            if (!commentText || !dmid || reportedDmids.has(dmid)) return;
            for (const config of reportConfig) {
                for (const keyword of config.keywords) {
                    let isMatch = false;
                    if (keyword.startsWith('/') && keyword.lastIndexOf('/') > 0) {
                        try {
                            const match = keyword.match(/^\/(.*)\/([gimyusv]*)$/);
                            if (match) {
                                const regex = new RegExp(match[1], match[2]);
                                isMatch = regex.test(commentText);
                            }
                        } catch (e) {
                            console.warn(`无效的正则表达式: "${keyword}"`, e);
                        }
                    } else {
                        isMatch = commentText.includes(keyword);
                    }

                    if (isMatch) {
                        commentsToReport.push({ dmid: dmid, reason: config.reason, text: commentText });
                        reportedDmids.add(dmid);
                        return;
                    }
                }
            }
        });

        if (commentsToReport.length === 0) {
            logToUI('在所有弹幕中未找到符合举报条件的弹幕。', 'warn');
            reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return;
        }

        logToUI(`筛选完毕，共找到 <b>${commentsToReport.length}</b> 条待举报弹幕。`);
        const confirmed = confirm(`即将举报 ${commentsToReport.length} 条弹幕，是否继续？`);
        if (!confirmed) {
            logToUI("用户取消了举报操作。", 'warn');
            reportState = 'idle'; startButton.disabled = false; startButton.textContent = '开始举报'; return;
        }

        currentIndex = 0;
        startButton.disabled = false;
        processReportQueue();
    }

    async function onControlButtonClick() {
        const startButton = document.getElementById('start-report-btn');
        if (startButton.disabled) return;

        if (reportState === 'running') {
            reportState = 'paused';
            startButton.textContent = `继续举报 (${currentIndex + 1}/${commentsToReport.length})`;
            logToUI("<b>举报已暂停。</b>", 'warn');
            return;
        }

        if (reportState === 'paused') {
            reportState = 'running';
            logToUI("<b>举报已恢复。</b>", 'warn');
            processReportQueue();
            return;
        }

        if (reportState === 'idle') {
            startNewTask();
        }
    }

    // --- UI 和配置管理 ---
    async function loadConfig() {
        const savedConfig = await GM_getValue('reportConfig_v1');
        if (savedConfig) {
            reportConfig = JSON.parse(savedConfig);
        } else {
            reportConfig = defaultConfig;
        }
        renderConfigUI();
    }

    function renderConfigUI() {
        const container = document.getElementById('config-rules-container');
        if (!container) return;
        container.innerHTML = '';
        reportConfig.forEach((rule, index) => {
            const ruleDiv = document.createElement('div');
            ruleDiv.className = 'config-rule-row';
            ruleDiv.dataset.index = index;

            const keywordsInput = document.createElement('input');
            keywordsInput.type = 'text';
            keywordsInput.className = 'keywords-input';
            keywordsInput.placeholder = '关键词,用逗号隔开';
            keywordsInput.value = rule.keywords.join(',');

            const reasonSelect = document.createElement('select');
            reasonSelect.className = 'reason-select';
            for (const [code, text] of Object.entries(reasonMap)) {
                const option = document.createElement('option');
                option.value = code;
                option.textContent = text;
                if (parseInt(code) === rule.reason) {
                    option.selected = true;
                }
                reasonSelect.appendChild(option);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-rule-btn';
            deleteBtn.textContent = '删除';

            ruleDiv.appendChild(keywordsInput);
            ruleDiv.appendChild(reasonSelect);
            ruleDiv.appendChild(deleteBtn);
            container.appendChild(ruleDiv);
        });
    }

    function saveConfig() {
        const newConfig = [];
        document.querySelectorAll('.config-rule-row').forEach(row => {
            const keywords = row.querySelector('.keywords-input').value.split(',').map(k => k.trim()).filter(Boolean);
            const reason = parseInt(row.querySelector('.reason-select').value);
            if (keywords.length > 0) {
                newConfig.push({ keywords, reason });
            }
        });
        reportConfig = newConfig;
        GM_setValue('reportConfig_v1', JSON.stringify(reportConfig));
        alert('配置已保存！');
        renderConfigUI();
    }

    function resetTask() {
        reportState = 'idle';
        commentsToReport = [];
        currentIndex = 0;
        const logContent = document.getElementById('report-log-content');
        if (logContent) logContent.innerHTML = '';
        const startButton = document.getElementById('start-report-btn');
        if (startButton) {
            startButton.disabled = false;
            startButton.textContent = '开始举报';
        }
        logToUI('任务已重置。');
    }


    function injectUI() {
        if (document.getElementById('batch-report-main-btn')) return;

        const styles = `
            #report-log-panel { display: none; position: fixed; top: 150px; left: 30px; z-index: 9999; width: 480px; max-width: 90vw; background: #fff; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.3); font-size: 14px; color: #333; }
            #report-log-header { padding: 10px 15px; background: #f25d8e; color: white; border-top-left-radius: 8px; border-top-right-radius: 8px; cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center; }
            #report-log-close { cursor: pointer; font-size: 20px; font-weight: bold; }
            #report-tabs { display: flex; border-bottom: 1px solid #eee; }
            .report-tab-btn { background: #f9f9f9; border: none; padding: 10px 15px; cursor: pointer; font-size: 14px; }
            .report-tab-btn.active { background: #fff; border-bottom: 2px solid #f25d8e; }
            .report-tab-content { display: none; }
            .report-tab-content.active { display: block; }
            #report-log-content { height: 300px; overflow-y: scroll; padding: 10px; background: #f9f9f9; }
            #report-log-content p { margin: 0 0 5px; padding: 0; line-height: 1.5; word-break: break-all; }
            .log-info { color: #333; } .log-success { color: #28a745; } .log-error { color: #dc3545; font-weight: bold; } .log-warn { color: #e6a23c; }
            #report-config-content { padding: 10px; height: 300px; overflow-y: auto; }
            .config-hint { font-size: 12px; color: #999; margin-bottom: 10px; }
            .config-rule-row { display: flex; margin-bottom: 8px; align-items: center; }
            .keywords-input { flex-grow: 1; padding: 5px; border: 1px solid #ccc; border-radius: 4px; }
            .reason-select { margin: 0 8px; padding: 5px; border: 1px solid #ccc; border-radius: 4px; }
            .delete-rule-btn, #add-rule-btn { background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
            #add-rule-btn { background: #28a745; margin-top: 10px; }
            #report-log-footer { padding: 10px; text-align: center; border-top: 1px solid #eee; }
            .footer-btn { background-color: #00a1d6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background-color 0.2s; margin: 0 5px; }
            .footer-btn:hover { background-color: #00b5e5; }
            .footer-btn:disabled { background-color: #aaa; cursor: not-allowed; }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);

        const mainButton = document.createElement('div');
        mainButton.id = 'batch-report-main-btn';
        mainButton.textContent = '批量举报';
        Object.assign(mainButton.style, {
            position: 'fixed', bottom: '30px', left: '30px', zIndex: '9998',
            cursor: 'pointer', backgroundColor: '#f25d8e', color: 'white',
            padding: '10px 15px', borderRadius: '8px', fontSize: '14px',
            fontWeight: 'bold', boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
            userSelect: 'none', transition: 'transform 0.2s ease'
        });
        mainButton.onmouseover = () => { mainButton.style.transform = 'scale(1.05)'; };
        mainButton.onmouseout = () => { mainButton.style.transform = 'scale(1)'; };

        const logPanel = document.createElement('div');
        logPanel.id = 'report-log-panel';
        logPanel.innerHTML = `
            <div id="report-log-header">
                <span>批量举报工具</span>
                <span id="report-log-close">&times;</span>
            </div>
            <div id="report-tabs">
                <button class="report-tab-btn active" data-tab="log">日志</button>
                <button class="report-tab-btn" data-tab="config">配置</button>
            </div>
            <div id="report-log-content" class="report-tab-content active"></div>
            <div id="report-config-content" class="report-tab-content">
                <p class="config-hint">提示：关键词使用英文逗号 "," 分割。若要使用正则表达式，请用 "/" 包裹，例如 /^(.)\\1{5,}$/</p>
                <div id="config-rules-container"></div>
                <button id="add-rule-btn">添加规则</button>
            </div>
            <div id="report-log-footer">
                <button id="save-config-btn" class="footer-btn" style="display:none;">保存配置</button>
                <button id="reload-info-btn" class="footer-btn">重新获取信息(切换分P)</button>
                <button id="start-report-btn" class="footer-btn">开始举报</button>
            </div>
        `;

        document.body.appendChild(mainButton);
        document.body.appendChild(logPanel);

        mainButton.onclick = () => { logPanel.style.display = 'block'; };
        document.getElementById('report-log-close').onclick = () => { logPanel.style.display = 'none'; };
        document.getElementById('start-report-btn').onclick = onControlButtonClick;
        document.getElementById('save-config-btn').onclick = saveConfig;
        document.getElementById('reload-info-btn').onclick = () => {
            if (reportState === 'running' || reportState === 'paused') {
                if (!confirm('当前有举报任务正在进行或已暂停，确定要重置并重新获取信息吗？')) return;
            }
            resetTask();
            startNewTask();
        };
        document.getElementById('add-rule-btn').onclick = () => {
            reportConfig.push({ keywords: [], reason: 9 });
            renderConfigUI();
        };

        const tabs = document.querySelectorAll('.report-tab-btn');
        const contents = document.querySelectorAll('.report-tab-content');
        const startBtn = document.getElementById('start-report-btn');
        const saveBtn = document.getElementById('save-config-btn');
        const reloadBtn = document.getElementById('reload-info-btn');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                contents.forEach(c => c.classList.remove('active'));
                const targetContent = document.getElementById(`report-${tab.dataset.tab}-content`);
                targetContent.classList.add('active');

                if (tab.dataset.tab === 'config') {
                    startBtn.style.display = 'none';
                    reloadBtn.style.display = 'none';
                    saveBtn.style.display = 'inline-block';
                } else {
                    startBtn.style.display = 'inline-block';
                    reloadBtn.style.display = 'inline-block';
                    saveBtn.style.display = 'none';
                }
            });
        });

        document.getElementById('config-rules-container').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-rule-btn')) {
                const ruleRow = e.target.closest('.config-rule-row');
                const index = parseInt(ruleRow.dataset.index);
                reportConfig.splice(index, 1);
                renderConfigUI();
            }
        });

        const header = document.getElementById('report-log-header');
        let isDragging = false, offsetX, offsetY;
        header.onmousedown = (e) => {
            isDragging = true;
            offsetX = e.clientX - logPanel.offsetLeft;
            offsetY = e.clientY - logPanel.offsetTop;
            document.onmousemove = (e) => {
                if (isDragging) {
                    logPanel.style.left = (e.clientX - offsetX) + 'px';
                    logPanel.style.top = (e.clientY - offsetY) + 'px';
                }
            };
            document.onmouseup = () => { isDragging = false; document.onmousemove = null; document.onmouseup = null; };
        };

        loadConfig();
        console.log('Bilibili 弹幕批量举报脚本：UI注入成功。');
    }

    const observer = new MutationObserver((mutationsList, obs) => {
        if (document.querySelector('.bpx-player-video-wrap')) {
            injectUI();
            obs.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
