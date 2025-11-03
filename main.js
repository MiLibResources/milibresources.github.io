'use strict';

const LIBRARIES_URL = 'libraries.json';
const RESOURCES_URL = 'resources.json';
const PAGE_STEP = 10;

let libraries = [];
let resources = [];
let locBySlug = new Map();
let categories = new Set();
let userPoint = null;
let searchQuery = '';
let route = null;
let visibleCount = PAGE_STEP;

const useGeoBtn = document.getElementById('use-geo');
const categorySel = document.getElementById('category');
const searchInput = document.getElementById('search');
const statusText = document.getElementById('status-text');
const contentEl = document.getElementById('content');
const aboutBtn = document.getElementById('about-btn');
const aboutPanel = document.getElementById('about-panel');

const spinner = document.getElementById('spinner');
const spinnerText = document.getElementById('spinner-text');

function showSpinner(text) {
	if(!spinner) return;
	if(text && spinnerText) spinnerText.textContent = text;
	spinner.removeAttribute('hidden');
}

function hideSpinner() {
	if(spinner) spinner.setAttribute('hidden', '');
}

function deg2rad(d) {
	return d * (Math.PI / 180);
}

function haversine(a, b) {
	const R = 6371e3;
	const dLat = deg2rad(b.lat - a.lat);
	const dLon = deg2rad(b.lon - a.lon);
	const s1 = Math.sin(dLat / 2),
		s2 = Math.sin(dLon / 2);
	const aa = s1 * s1 + Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * s2 * s2;
	return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function fmtDistance(m) {
	if(m < 950) return String(Math.round(m)) + ' m';
	const mi = m / 1609.344;
	return mi.toFixed(mi < 10 ? 1 : 0) + ' mi';
}

function esc(s) {
	const div = document.createElement('div');
	div.textContent = String(s == null ? '' : s);
	return div.innerHTML;
}

function normCat(c) {
	if(Array.isArray(c)) return c.map(function(x) {
		return String(x).trim();
	}).filter(Boolean);
	if(typeof c === 'string') return [c.trim()].filter(Boolean);
	return [];
}

function toPoint(o) {
	if(!o) return null;
	const lat = Number(o.lat != null ? o.lat : (o.Lat != null ? o.Lat : (o.latitude != null ? o.latitude : o.Latitude)));
	const lon = Number(o.lon != null ? o.lon : (o.Lon != null ? o.Lon : (o.lng != null ? o.lng : (o.Lng != null ? o.Lng : (o.longitude != null ? o.longitude : o.Longitude)))));
	return (isFinite(lat) && isFinite(lon)) ? {
		lat: lat,
		lon: lon
	} : null;
}

function coerceList(data) {
	if(Array.isArray(data)) return data;
	for(var k in (data || {}))
		if(Array.isArray(data[k])) return data[k];
	return [];
}
async function loadJSON(url) {
	const r = await fetch(url, {
		credentials: 'omit'
	});
	if(!r.ok) throw new Error(url + ': ' + r.status);
	return r.json();
}

function debounce(fn, ms) {
	var t;
	return function() {
		var args = arguments;
		clearTimeout(t);
		t = setTimeout(function() {
			fn.apply(null, args);
		}, ms || 200);
	};
}

function mapHrefAddress(address) {
	return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
}

function addressText(obj) {
	if(!obj) return '';
	var a = obj.address != null ? obj.address : obj.Address;
	var c = obj.city != null ? obj.city : obj.City;
	var s = obj.state != null ? obj.state : obj.State;
	var z = obj.zip != null ? obj.zip : obj.Zip;
	return [a, c, s, z].filter(Boolean).join(', ');
}

function getMapLink(obj) {
	if(!obj) return '';
	var direct = (obj.gmapaddr != null ? obj.gmapaddr : (obj.gmapAddr != null ? obj.gmapAddr : obj.GMapAddr));
	if(typeof direct === 'string' && direct.trim()) return direct.trim();
	var addr = addressText(obj);
	return addr ? mapHrefAddress(addr) : '';
}

function slugify(str) {
	str = String(str || '').toLowerCase();
	try {
		str = str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
	} catch (e) {}
	str = str.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return str || 'loc';
}

function slugFromLocation(l, idx) {
	var name = (l && (l.Name || l.name)) || ('location-' + idx);
	var pt = toPoint(l);
	var tail = pt ? ('-' + pt.lat.toFixed(4) + '-' + pt.lon.toFixed(4)) : ('-' + idx);
	return slugify(name) + tail;
}

function parseHash() {
	var h = (location.hash || '').replace(/^#/, '');
	if(!h) return {
		type: 'home'
	};
	var m = h.match(/^loc-(.+)$/);
	if(m) return {
		type: 'loc',
		slug: m[1]
	};
	return {
		type: 'home'
	};
}

function goHome() {
	location.hash = '';
}

function goToLoc(slug) {
	location.hash = 'loc-' + slug;
}

let map, resLayer, locLayer, userMarker;

function makeIcon(file) {
	return L.icon({
		iconUrl: './' + file,
		iconSize: [28, 28],
		iconAnchor: [14, 14],
		popupAnchor: [0, -14]
	});
}
const ICONS = {
	library: makeIcon('library.svg'),
	shelter: makeIcon('shelter.svg'),
	health: makeIcon('health.svg'),
	financial: makeIcon('financial.svg'),
	educational: makeIcon('education.svg'),
	childcare: makeIcon('childcare.svg'),
	food: makeIcon('food.svg'),
	giveaway: makeIcon('giveaway.svg')
};
const CATEGORY_ORDER = ['shelter', 'health', 'financial', 'educational', 'childcare', 'food', 'giveaway'];

function iconForResource(r) {
	const cats = normCat(r.category).map(function(c) {
		return c.toLowerCase();
	});
	for(var i = 0; i < CATEGORY_ORDER.length; i++) {
		var key = CATEGORY_ORDER[i];
		if(cats.indexOf(key) !== -1) return ICONS[key] || null;
	}
	return null;
}

function ensureMap() {
	if(map) return;
	map = L.map('map', {
		zoomControl: true,
		preferCanvas: true
	});
	L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '&copy; OpenStreetMap contributors'
	}).addTo(map);
	resLayer = L.layerGroup().addTo(map);
	locLayer = L.layerGroup().addTo(map);
	requestAnimationFrame(function() {
		map.invalidateSize();
	});
}

function clearMap() {
	if(!map) return;
	resLayer.clearLayers();
	locLayer.clearLayers();
	if(userMarker) {
		map.removeLayer(userMarker);
		userMarker = null;
	}
}

function circle(lat, lon, opts) {
	return L.circleMarker([lat, lon], Object.assign({
		radius: 6,
		weight: 1.5,
		color: '#0B9A6D',
		fillColor: '#0B9A6D',
		fillOpacity: 0.95
	}, opts || {}));
}

function updateMap(shownResources, shownLocations) {
	if(!userPoint) {
		if(map) clearMap();
		return;
	}
	ensureMap();
	clearMap();

	requestAnimationFrame(function() {
		const allLatLngs = [];

		userMarker = L.circleMarker([userPoint.lat, userPoint.lon], {
			radius: 7,
			weight: 2,
			color: '#18453B',
			fillColor: '#18453B',
			fillOpacity: 1
		}).addTo(map).bindPopup('You are here');
		allLatLngs.push([userPoint.lat, userPoint.lon]);

		(shownResources || []).forEach(function(r) {
			const pt = toPoint(r);
			if(!pt) return;
			const nm = esc(r.name || 'Resource');
			const addr = esc(addressText(r) || '');
			const url = r.URL ? ('<a href="' + esc(r.URL) + '" target="_blank" rel="noopener">' + nm + '</a>') : ('<strong>' + nm + '</strong>');
			const icon = iconForResource(r);
			const marker = icon ? L.marker([pt.lat, pt.lon], {
				icon: icon
			}) : circle(pt.lat, pt.lon);
			marker.addTo(resLayer).bindPopup(url + (addr ? ('<br/>' + addr) : ''));
			allLatLngs.push([pt.lat, pt.lon]);
		});

		(shownLocations || []).forEach(function(l) {
			const pt = toPoint(l);
			if(!pt) return;
			const base = esc(l && (l.Name || l.name) || 'Library');
			const group = (l && (l.Group || l.group)) || '';
			const disp = group ? (base + ' \u2013 ' + esc(group)) : base;
			const slug = l.__slug;
			L.marker([pt.lat, pt.lon], {
					icon: ICONS.library
				})
				.addTo(locLayer)
				.bindPopup('<a href="#" onclick="(function(){ location.hash=\'loc-' + slug + '\'; })(); return false;">' + disp + '</a>');
			allLatLngs.push([pt.lat, pt.lon]);
		});

		if(allLatLngs.length > 1) {
			const bounds = L.latLngBounds(allLatLngs);
			map.fitBounds(bounds, {
				padding: [28, 28],
				maxZoom: 13
			});
		} else {
			map.setView([userPoint.lat, userPoint.lon], 12);
		}

		requestAnimationFrame(function() {
			map.invalidateSize();
		});
	});
}

async function init() {
	showSpinner('Loading data…');
	try {
		const both = await Promise.all([loadJSON(LIBRARIES_URL), loadJSON(RESOURCES_URL)]);
		const libsRaw = both[0],
			resRaw = both[1];
		libraries = coerceList(libsRaw).slice();
		resources = coerceList(resRaw).slice();

		locBySlug.clear();
		libraries.forEach(function(l, i) {
			const slug = slugFromLocation(l, i);
			l.__slug = slug;
			locBySlug.set(slug, l);
		});

		categories.clear();
		resources.forEach(function(r) {
			normCat(r.category).forEach(function(c) {
				categories.add(c);
			});
		});

		categorySel.innerHTML = '<option value="__ALL__">All categories</option>';
		Array.from(categories).sort(function(a, b) {
			return a.localeCompare(b);
		}).forEach(function(c) {
			const opt = document.createElement('option');
			opt.value = c;
			opt.textContent = c;
			categorySel.appendChild(opt);
		});

		hideSpinner();
		setFromGeo();

		route = parseHash();
		render();
	} catch (err) {
		hideSpinner();
		statusText.textContent = 'Failed to load data.';
		contentEl.innerHTML = '<article class="card">Error: ' + esc(err.message) + '</article>';
		console.error(err);
	}
}

function setUserPoint(pt) {
	userPoint = pt;
	statusText.textContent = 'Closest resources to your location:';
	render();
}

function setFromGeo() {
	if(!('geolocation' in navigator)) return;
	showSpinner('Getting your location…');
	navigator.geolocation.getCurrentPosition(
		function(pos) {
			hideSpinner();
			setUserPoint({
				lat: pos.coords.latitude,
				lon: pos.coords.longitude
			});
		},
		function() {
			hideSpinner();
			render();
		}, {
			enableHighAccuracy: true,
			timeout: 10000,
			maximumAge: 60000
		}
	);
}

function filterByCategory(list) {
	const sel = categorySel.value;
	if(sel === '__ALL__') return list;
	return list.filter(function(r) {
		return normCat(r.category).indexOf(sel) !== -1;
	});
}

function matchesResQuery(r, q) {
	q = String(q || '').trim().toLowerCase();
	if(!q) return true;
	const parts = q.split(/\s+/).filter(Boolean);
	const addr = addressText(r);
	const cats = normCat(r.category).join(' ');
	const hay = [r.name, r.description, cats, addr].filter(Boolean).join(' ').toLowerCase();
	return parts.every(function(tok) {
		return hay.indexOf(tok) !== -1;
	});
}

function matchesLocQuery(l, q) {
	q = String(q || '').trim().toLowerCase();
	if(!q) return true;
	const parts = q.split(/\s+/).filter(Boolean);
	const name = String((l && (l.Name || l.name)) || '').toLowerCase();
	const group = String((l && (l.Group || l.group)) || '').toLowerCase();
	const addr = addressText(l).toLowerCase();
	const hay = [name, group, addr].filter(Boolean).join(' ');
	return parts.every(function(tok) {
		return hay.indexOf(tok) !== -1;
	});
}

function renderPager(total) {
	const pagerEl = document.getElementById('pager');
	pagerEl.innerHTML = '';
	if(total <= PAGE_STEP) return;
	const btn = document.createElement('button');
	btn.className = 'btn';
	if(visibleCount < total) {
		const inc = Math.min(PAGE_STEP, total - visibleCount);
		btn.textContent = 'Show more (+' + inc + ')';
		btn.onclick = function() {
			visibleCount = Math.min(total, visibleCount + PAGE_STEP);
			render();
		};
	} else {
		const dec = Math.min(PAGE_STEP, visibleCount - PAGE_STEP);
		if(dec <= 0) return;
		btn.textContent = 'Show less (-' + dec + ')';
		btn.onclick = function() {
			visibleCount = Math.max(PAGE_STEP, visibleCount - PAGE_STEP);
			render();
		};
	}
	pagerEl.appendChild(btn);
}

function renderHome() {
	contentEl.innerHTML = '' +
		'<section id="results" class="results" aria-live="polite"></section>' +
		'<div id="pager" class="btnbar"></div>' +
		'<h2 class="section-title" id="libs-title" style="display:none;">Nearest libraries</h2>' +
		'<section id="nearby-libs" class="results" aria-live="polite"></section>';

	const resultsEl = document.getElementById('results');
	const libsTitleEl = document.getElementById('libs-title');
	const nearbyLibsEl = document.getElementById('nearby-libs');

	if(!userPoint) {
		resultsEl.innerHTML = '<article class="card"><p>Enable location or tap “Use precise location” to see nearby resources.</p></article>';
		libsTitleEl.style.display = 'none';
		nearbyLibsEl.innerHTML = '';
		updateMap([], []);
		return;
	}

	const filteredRes = filterByCategory(resources)
		.filter(function(r) {
			return !!toPoint(r);
		})
		.filter(function(r) {
			return matchesResQuery(r, searchQuery);
		});
	const rankedRes = filteredRes
		.map(function(r) {
			return {
				r: r,
				m: haversine(userPoint, toPoint(r))
			};
		})
		.sort(function(a, b) {
			return a.m - b.m;
		});

	const toShow = rankedRes.slice(0, visibleCount);
	resultsEl.innerHTML = toShow.length ? '' : '<article class="card">No resources match your filters.</article>';
	toShow.forEach(function(pair) {
		const r = pair.r,
			m = pair.m;
		const cats = normCat(r.category);
		const addrStr = addressText(r);
		const mapLink = getMapLink(r);
		const nameHTML = r.URL ?
			'<a href="' + esc(r.URL) + '" target="_blank" rel="noopener">' + esc(r.name || 'Untitled resource') + '</a>' :
			esc(r.name || 'Untitled resource');
		const card = document.createElement('article');
		card.className = 'card';
		card.innerHTML = '' +
			'<div class="name-row">' +
			'<h3>' + nameHTML + '</h3>' +
			'<div class="inline-pills">' +
			cats.map(function(c) {
				return '<span class="pill">' + esc(c) + '</span>';
			}).join('') +
			'<span class="pill" title="Distance">' + fmtDistance(m) + '</span>' +
			'</div>' +
			'</div>' +
			(r.description ? ('<p>' + esc(r.description) + '</p>') : '') +
			(addrStr ? ('<p class="muted"><a href="' + esc(mapLink) + '" target="_blank" rel="noopener">' + esc(addrStr) + '</a></p>') : '');
		resultsEl.appendChild(card);
	});

	renderPager(rankedRes.length);

	const withPts = libraries.filter(function(l) {
		return !!toPoint(l);
	});
	const filteredLibs = withPts.filter(function(l) {
		return matchesLocQuery(l, searchQuery);
	});
	const rankedLibs = filteredLibs
		.map(function(l) {
			return {
				l: l,
				m: haversine(userPoint, toPoint(l))
			};
		})
		.sort(function(a, b) {
			return a.m - b.m;
		})
		.slice(0, 5);

	libsTitleEl.style.display = rankedLibs.length ? '' : 'none';
	nearbyLibsEl.innerHTML = rankedLibs.length ? '' : '<article class="card">No libraries match your search.</article>';
	rankedLibs.forEach(function(pair) {
		const l = pair.l,
			m = pair.m;
		const addrStr = addressText(l);
		const baseName = esc((l && (l.Name || l.name)) || 'Library');
		const group = (l && (l.Group || l.group)) || '';
		const displayName = group ? (baseName + ' \u2013 ' + esc(group)) : baseName;
		const nameHTML = '<a href="#" class="loc-link" data-slug="' + esc(String(l.__slug)) + '">' + displayName + '</a>';
		const mapLink = getMapLink(l);
		const card = document.createElement('article');
		card.className = 'card';
		card.innerHTML = '' +
			'<div class="name-row">' +
			'<h3>' + nameHTML + '</h3>' +
			'<div class="inline-pills"><span class="pill" title="Distance">' + fmtDistance(m) + '</span></div>' +
			'</div>' +
			(addrStr ? ('<p class="muted"><a href="' + esc(mapLink) + '" target="_blank" rel="noopener">' + esc(addrStr) + '</a></p>') : '');
		nearbyLibsEl.appendChild(card);
	});

	nearbyLibsEl.addEventListener('click', function(e) {
		const a = e.target.closest && e.target.closest('.loc-link');
		if(!a) return;
		e.preventDefault();
		const slug = a.getAttribute('data-slug');
		if(slug) goToLoc(slug);
	}, {
		once: true
	});

	updateMap(toShow.map(function(x) {
		return x.r;
	}), rankedLibs.map(function(x) {
		return x.l;
	}));
	if(map) requestAnimationFrame(function() {
		map.invalidateSize();
	});
}

function renderLocationDetail(slug) {
	const loc = locBySlug.get(String(slug));
	contentEl.innerHTML = '';
	if(!loc) {
		contentEl.innerHTML = '<a class="backlink" href="#" onclick="history.back(); return false;">← Back</a><article class="card"><p>Library not found.</p></article>';
		updateMap([], []);
		return;
	}
	const locPt = toPoint(loc);
	const addrStr = addressText(loc);
	const baseName = esc((loc && (loc.Name || loc.name)) || 'Library');
	const group = (loc && (loc.Group || loc.group)) || '';
	const displayNamePlain = group ? (baseName + ' \u2013 ' + esc(group)) : baseName;
	const locURL = (loc && (loc.URL || loc.url));
	const displayName = locURL ? ('<a href="' + esc(locURL) + '" target="_blank" rel="noopener">' + displayNamePlain + '</a>') : displayNamePlain;
	const locDesc = (loc && (loc.desc != null ? loc.desc : (loc.Desc != null ? loc.Desc : loc.description))) || '';
	const locMapLink = getMapLink(loc);

	const pool = resources.filter(function(r) {
		return !!toPoint(r);
	});
	const filteredByCat = filterByCategory(pool);
	const rankedNearby = (locPt ?
		filteredByCat.map(function(r) {
			return {
				r: r,
				m: haversine(locPt, toPoint(r))
			};
		}).sort(function(a, b) {
			return a.m - b.m;
		}) :
		filteredByCat.map(function(r) {
			return {
				r: r,
				m: Infinity
			};
		})
	);
	const nearest = rankedNearby.slice(0, 10).map(function(x) {
		return x.r;
	});

	const header = document.createElement('div');
	header.innerHTML = '' +
		'<a class="backlink" href="#" onclick="goHome(); return false;">← Back</a>' +
		'<article class="card">' +
		'<div class="name-row"><h3>' + displayName + '</h3></div>' +
		(locDesc ? ('<p>' + esc(locDesc) + '</p>') : '') +
		(addrStr ? ('<p class="muted"><a href="' + esc(locMapLink) + '" target="_blank" rel="noopener">' + esc(addrStr) + '</a></p>') : '') +
		'</article>' +
		'<h2 class="section-title">Nearest' + (categorySel.value !== '__ALL__' ? (' ' + esc(categorySel.value)) : '') + ' resources' + ' to ' + baseName + '</h2>';
	contentEl.appendChild(header);

	const listWrap = document.createElement('section');
	listWrap.className = 'results';
	if(!nearest.length) {
		const empty = document.createElement('article');
		empty.className = 'card';
		empty.innerHTML = '<p>No resources found for this library with the current filters.</p>';
		listWrap.appendChild(empty);
	} else {
		nearest.forEach(function(r) {
			const cats = normCat(r.category);
			const addrR = addressText(r);
			const mapLink = getMapLink(r);
			const nameHTML = r.URL ? ('<a href="' + esc(r.URL) + '" target="_blank" rel="noopener">' + esc(r.name || 'Untitled resource') + '</a>') : esc(r.name || 'Untitled resource');
			const card = document.createElement('article');
			card.className = 'card';
			card.innerHTML = '' +
				'<div class="name-row">' +
				'<h3>' + nameHTML + '</h3>' +
				'<div class="inline-pills">' + cats.map(function(c) {
					return '<span class="pill">' + esc(c) + '</span>';
				}).join('') + '</div>' +
				'</div>' +
				(r.description ? ('<p>' + esc(r.description) + '</p>') : '') +
				(addrR ? ('<p class="muted"><a href="' + esc(mapLink) + '" target="_blank" rel="noopener">' + esc(addrR) + '</a></p>') : '');
			listWrap.appendChild(card);
		});
	}
	contentEl.appendChild(listWrap);

	updateMap(nearest, [loc]);
	if(map) requestAnimationFrame(function() {
		map.invalidateSize();
	});
}

function render() {
	route = parseHash();
	if(route.type === 'loc') renderLocationDetail(route.slug);
	else renderHome();
}

if(useGeoBtn) useGeoBtn.addEventListener('click', setFromGeo, {
	passive: true
});
if(categorySel) categorySel.addEventListener('change', function() {
	if(route && route.type === 'loc') renderLocationDetail(route.slug);
	else {
		visibleCount = PAGE_STEP;
		render();
	}
});
if(searchInput) searchInput.addEventListener('input', debounce(function(e) {
	searchQuery = (e && e.target && e.target.value) ? e.target.value : '';
	if(route && route.type === 'loc') renderLocationDetail(route.slug);
	else {
		visibleCount = PAGE_STEP;
		render();
	}
}, 150), {
	passive: true
});
window.addEventListener('hashchange', render);

if(aboutBtn && aboutPanel) {
	aboutBtn.addEventListener('click', function() {
		const open = !aboutPanel.hasAttribute('hidden');
		if(open) {
			aboutPanel.setAttribute('hidden', '');
			aboutBtn.setAttribute('aria-expanded', 'false');
		} else {
			aboutPanel.removeAttribute('hidden');
			aboutBtn.setAttribute('aria-expanded', 'true');
		}
	});
}

init();
