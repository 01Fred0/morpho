// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { MorphoViewer } from './viewer.js';
import { loadMorphoCode, loadScript } from './utils.js';
import { HERO_DESIGNS } from './presets.js';

if ('history' in window && 'scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

window.addEventListener('beforeunload', () => {
    sessionStorage.setItem('scroll-position', window.scrollY);
});

// Hero Demo Carousel logic
let heroViewer = null;
let currentHeroIdx = 0;
let activeItem = null;
let heroCode = '';


// Shared Demo Utilities
function updateExploreLink(btnId, design, method) {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.href = `demo.html?design=${design}&method=${method}`;
    }
}

function syncPlayButton(btnId, isRunning) {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.textContent = isRunning ? "Pause" : "Resume";
    }
}

function setViewerState(design, inputs, method, isRunning = true) {
    if (!heroViewer) return;
    heroViewer.isRunning = isRunning;
    heroViewer.setDesign(design, inputs, method);
    heroViewer.startAutoExpand();
}

// Single place that puts the hero UI + viewer into the state described by a design item
function applyHeroItem(item, method = item.method || 'bfs') {
    activeItem = item;
    setHeroTitle(item);
    document.getElementById('hero-desc').innerHTML = item.desc;
    document.getElementById('select-hero-method').value = method;
    setViewerState(item.design[0], item.design[1], method);
    syncPlayButton('btn-hero-play', heroViewer.isRunning);
    updateExploreLink('btn-hero-explore', item.design[0], method);
}

function setHeroTitle(item) {
    const el = document.getElementById('hero-title');
    const counterEl = document.getElementById('hero-counter');
    if (counterEl) {
        const idx = HERO_DESIGNS.indexOf(item);
        if (idx !== -1 && !modalActive) {
            counterEl.textContent = `${idx + 1} / ${HERO_DESIGNS.length}`;
            counterEl.style.display = '';
        } else {
            counterEl.style.display = 'none';
        }
    }
    if (!el) return;
    if (item.anchor) {
        el.innerHTML = `<a href="${item.anchor}">${item.title}</a>`;
    } else {
        el.textContent = item.title;
    }
}

function initHeroViewer(MorphoViewer, code) {
    heroCode = code;
    const container = document.getElementById('hero-canvas-container');
    const item = HERO_DESIGNS[currentHeroIdx];
    activeItem = item;
    setHeroTitle(item);
    document.getElementById('hero-desc').innerHTML = item.desc;

    const isMobile = window.innerWidth <= 768;
    heroViewer = new MorphoViewer({
        container: container,
        design: item.design[0],
        inputs: item.design[1],
        visibility: 'both',
        autoExpandSpeed: 40,
        interactive: true,
        hover: false,
        autoscale: true,
        panY: isMobile ? -50 : -30,
        onGrowthComplete: () => {
            if (activeItem && activeItem.sim !== false) {
                heroViewer.startSimulation();
            }
        }
    });

    heroViewer.init(heroCode);
    updateExploreLink('btn-hero-explore', item.design[0], heroViewer.method);

    // Wire up controls
    const navigate = (dir) => {
        currentHeroIdx = (currentHeroIdx + dir + HERO_DESIGNS.length) % HERO_DESIGNS.length;
        showHeroDesign();
    };
    document.getElementById('btn-hero-prev').onclick = () => navigate(-1);
    document.getElementById('btn-hero-next').onclick = () => navigate(1);

    const btnPlay = document.getElementById('btn-hero-play');
    btnPlay.onclick = () => {
        if (heroViewer) {
            heroViewer.isRunning = !heroViewer.isRunning;
            syncPlayButton('btn-hero-play', heroViewer.isRunning);
        }
    };

    document.getElementById('btn-hero-expand').onclick = () => {
        if (heroViewer) {
            heroViewer.reset();
            heroViewer.startAutoExpand();
        }
    };

    const selectMethod = document.getElementById('select-hero-method');
    selectMethod.onchange = () => {
        if (heroViewer) applyHeroItem(activeItem || HERO_DESIGNS[currentHeroIdx], selectMethod.value);
    };

    // Pause hero loop when out of view
    const heroSec = document.querySelector('.hero-section');
    const heroObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (heroViewer && !modalActive) {
                if (entry.isIntersecting) {
                    heroViewer.startLoop();
                } else {
                    heroViewer.stopLoop();
                }
            }
        });
    }, { threshold: 0.01 });
    heroObserver.observe(heroSec);
}

function showHeroDesign() {
    if (!heroViewer) return;
    applyHeroItem(HERO_DESIGNS[currentHeroIdx]);
}

// Modal View & Figures interaction logic
let modalActive = false;

function openGrowthModal(key) {
    if (modalActive || !heroViewer) return;
    modalActive = true;
    window.figuresPaused = true;

    const modal = document.getElementById('growth-modal');
    const modalContent = document.querySelector('.modal-content');
    const heroCanvasContainer = document.getElementById('hero-canvas-container');
    const heroOverlay = document.querySelector('.hero-overlay');

    const item = HERO_DESIGNS.find(d => d.key === key);
    if (!item) {
        console.error(`Design key "${key}" not found in HERO_DESIGNS.`);
        modalActive = false;
        window.figuresPaused = false;
        return;
    }

    heroViewer.stopAutoExpand();
    heroViewer.stopSimulation();

    modalContent.appendChild(heroCanvasContainer);
    modalContent.appendChild(heroOverlay);
    document.getElementById('btn-hero-prev').style.display = 'none';
    const nextWrapper = document.getElementById('nav-next-wrapper');
    if (nextWrapper) nextWrapper.style.display = 'none';
    const nextBtn = document.getElementById('btn-hero-next');
    if (nextBtn) nextBtn.style.display = 'none';

    heroViewer.hover = true;
    applyHeroItem(item);

    modal.classList.add('active');
}

function closeGrowthModal() {
    if (!modalActive || !heroViewer) return;
    modalActive = false;
    window.figuresPaused = false;

    const modal = document.getElementById('growth-modal');
    const heroCanvasContainer = document.getElementById('hero-canvas-container');
    const heroOverlay = document.querySelector('.hero-overlay');
    const heroSection = document.querySelector('.hero-section');

    heroViewer.stopAutoExpand();
    heroViewer.stopSimulation();
    heroViewer.hover = false;

    heroSection.insertBefore(heroCanvasContainer, heroSection.firstChild);
    heroSection.appendChild(heroOverlay);
    document.getElementById('btn-hero-prev').style.display = '';
    const nextWrapper = document.getElementById('nav-next-wrapper');
    if (nextWrapper) nextWrapper.style.display = '';
    const nextBtn = document.getElementById('btn-hero-next');
    if (nextBtn) nextBtn.style.display = '';

    applyHeroItem(HERO_DESIGNS[currentHeroIdx]);

    modal.classList.remove('active');
}

function setupArticleFiguresClick() {
    const layouts = document.querySelectorAll('.morpho-layout');
    layouts.forEach(layout => {
        const key = layout.getAttribute('data-key');
        if (key) {
            layout.addEventListener('click', () => {
                openGrowthModal(key);
            });
        }
    });
}

function setupMobileTOC() {
    const toggleBtn = document.getElementById('btn-toc-toggle');
    const sidebar = document.querySelector('.toc-sidebar');
    if (!toggleBtn || !sidebar) return;

    const toggle = () => {
        const open = sidebar.classList.toggle('open');
        toggleBtn.classList.toggle('active', open);
    };

    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        toggle();
    };

    document.onclick = (e) => {
        if (sidebar.classList.contains('open') && (!sidebar.contains(e.target) || e.target.tagName === 'A')) {
            toggle();
        }
    };
}

// Wire up modal global closers
document.getElementById('btn-modal-close').onclick = closeGrowthModal;
document.getElementById('growth-modal').onclick = (e) => {
    if (e.target === document.getElementById('growth-modal')) {
        closeGrowthModal();
    }
};
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeGrowthModal();
    }
});

// Load Morpho code and initialize hero animation independently
loadMorphoCode('.').then(code => {
    initHeroViewer(MorphoViewer, code);
    if (heroViewer) {
        heroViewer.startAutoExpand();
    }
}).catch(err => {
    console.error("Failed to load Morpho code:", err);
});

// Load and render article independently
async function loadAndRenderArticle() {
    try {
        const response = await fetch('article.md');
        if (!response.ok) throw new Error('Failed to load article.md');
        const markdown = await response.text();
        
        const prismPromise = renderArticle(markdown);
        if (heroViewer) {
            heroViewer.startAutoExpand();
        }
        
        // Wait for Prism highlighting to finish so heights are stable
        await prismPromise;
        
        // Restore scroll position or scroll to URL hash
        if (window.location.hash) {
            const targetEl = document.querySelector(window.location.hash);
            if (targetEl) targetEl.scrollIntoView({ behavior: 'instant' });
        } else {
            const savedScroll = sessionStorage.getItem('scroll-position');
            if (savedScroll) {
                window.scrollTo({ top: parseInt(savedScroll, 10), behavior: 'instant' });
            }
        }
        
        setupArticleFiguresClick();
        setupMobileTOC();
        
        // Initialize dynamic layouts in the background
        const m = await import('./figures.js');
        await m.initMorphoLayouts();
    } catch (error) {
        document.getElementById('article-content').innerHTML = `
            <div style="color: #ef4444; padding: 20px; border: 1px solid #ef4444; border-radius: 8px; background: rgba(239, 68, 68, 0.05);">
                <h3 style="margin-top: 0;">Error Loading Article</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
}

loadAndRenderArticle();

async function renderArticle(markdown) {
    // Render markdown using Marked library
    document.getElementById('article-content').innerHTML = marked.parse(markdown);

    // Generate IDs for all headings so anchor navigation always works
    const allHeadings = document.getElementById('article-content').querySelectorAll('h1, h2, h3, h4, h5, h6');
    allHeadings.forEach(heading => {
        const slug = heading.textContent.toLowerCase().trim()
            .replace(/[–—]/g, '-')
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        heading.id = slug;
    });

    // Generate Table of Contents
    const headings = document.getElementById('article-content').querySelectorAll('h2, h3');
    const tocContainer = document.getElementById('toc-content');
    if (headings.length > 0 && tocContainer) {
        const ul = document.createElement('ul');
        headings.forEach(heading => {
            const li = document.createElement('li');
            li.className = `toc-${heading.tagName.toLowerCase()}`;
            const a = document.createElement('a');
            a.href = `#${heading.id}`;
            a.textContent = heading.textContent;

            li.appendChild(a);
            ul.appendChild(li);
        });
        tocContainer.appendChild(ul);

        // Scroll Spy / TOC Highlighting
        const headingsList = Array.from(headings);
        const tocLinks = Array.from(ul.querySelectorAll('a'));

        function updateActiveToc() {
            const headerOffset = 100;
            let activeHeading = null;

            for (let i = 0; i < headingsList.length; i++) {
                const heading = headingsList[i];
                const top = heading.getBoundingClientRect().top;
                if (top < headerOffset) {
                    activeHeading = heading;
                } else {
                    break;
                }
            }

            tocLinks.forEach(link => {
                const isActive = activeHeading && link.getAttribute('href') === `#${activeHeading.id}`;
                link.parentElement.classList.toggle('active', isActive);
            });
        }

        // Run once on load to highlight initial section
        updateActiveToc();

        // Listen to scroll events
        window.addEventListener('scroll', () => {
            window.requestAnimationFrame(updateActiveToc);
        }, { passive: true });
    }

    // Highlight Python code blocks asynchronously
    try {
        await loadScript('third_party/prism/prism-core.min.js');
        await loadScript('third_party/prism/prism-python.min.js');
        if (window.Prism) {
            Prism.highlightAll();
        }
    } catch (err) {
        console.error("Failed to load syntax highlighter:", err);
    }
}

