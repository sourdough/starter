// import '/lib/external/construct-style-sheets-polyfill.js';
import { Router } from 'https://sourdough.github.io/wildtype/@vaadin/router/dist/vaadin-router.js';
import { ReactiveElement, LitElement, html, svg, css, 
	msg, updateWhenLocaleChanges, localeList, localeDictionary, setLocale, getLocale, updateLocaleFromUrl } from './deps.js';

const routes = [
{ path:'/', animate: true, children: [
	{path: '/(starter/www/)?', component: 'page-common', action: async ()=> import('./page-common.js') },
	{path: '/(page[1-3])', component: 'page-common', action: async ()=> import('./page-common.js') },
	{path: '/contact', component: 'page-contact', action: async ()=> import('./page-contact.js') },
	// 404
	{path: '(.*)', component: 'page-404', action: async ()=> import('./page-404.js') }
] }
];

customElements.get('sour-dough') || customElements.define('sour-dough', class SourDough extends LitElement{
	static get properties(){
		return {
		}
	}
	static get styles(){
		return css`
			:host{
				display:block;
			}
		`;
	}
	constructor(){
		super();
		updateWhenLocaleChanges(this);
	}
/*
	createRenderRoot() {
		return this.attachShadow({ mode: 'open', delegatesFocus: true, });
	}
*/
	connectedCallback(){
		super.connectedCallback();
		self.addEventListener('vaadin-router-location-changed', this.locationChanged);
		self.addEventListener('vaadin-router-go', this.locationGo);
	}
	disconnectedCallback(){
		super.disconnectedCallback();
		self.removeEventListener('vaadin-router-location-changed', this.locationChanged);
		self.removeEventListener('vaadin-router-go', this.locationGo);
	}
	locationGo({type, detail}){
		const { hash, pathname, search } = detail;
		// preserve search options (hash is page-view specific, transient and not passed?)
		let site = location.search;
		if(site){
			if(search){
			// merge
				const params = new URLSearchParams(search);
				new URLSearchParams(site).forEach((val, name)=>params.set(name, val));
				detail.search = '?'+params.toString();
			}else{
				detail.search = site;
			}
		}
	}
	locationChanged(event){
		const {type, detail, target} = event;
		updateLocaleFromUrl();
		const { location } = detail;
		const { baseUrl, hash, path, pathname, redirectFrom, route, search } = location;
		console.warn({type, detail, event, location, baseUrl, hash, path, pathname, redirectFrom, route, search });
	}
	render(){
		return html`<slot>...</slot>`;
	}
	firstUpdated() {
		const router = new Router(document.querySelector('[outlet]'));
		router.setRoutes(routes);

		Object.assign(this, {localeList, setLocale, getLocale});

		requestAnimationFrame(()=>{
			// lazy setup
			import('./sour-locale.js');
			import('./sour-part.js');
		});
	}
});

