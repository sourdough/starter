// import '/lib/external/construct-style-sheets-polyfill.js';
import { Router } from '/wildtype/@vaadin/router/dist/vaadin-router.js';

import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';

import { msg, updateWhenLocaleChanges, localeList, localeDictionary, setLocale, getLocale, updateLocaleFromUrl } from './locales.js';

// TODO
const routes = [
{ path:'/', animate: true, children: [
	{path: '/', component: 'tag-name', action: async ()=> import('./sour-tag.js') },
	{path: '/contact', component: 'tag-name', action: async ()=> import('./sour-tag.js') },
	// 404
	{path: '(.*)', component: 'tag-name', action: async ()=> import('./sour-tag.js') }
] }
];


customElements.define('sour-dough', class SourDough extends LitElement{
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
		console.warn({type, detail});
		// preserve any options
		// TODO merge them
		detail.search = location.search;
		detail.hash = location.hash;
	}
	locationChanged({type, detail}){
		updateLocaleFromUrl();
		console.log({type, detail});
	}
	render(){
		return html`${ msg('...', {id:'key.key'}) }, ${ msg('text', {id: 'demo.text.sample', desc: 'some text to show'}) }<slot>...</slot> <div outlet></div>`;
	}
	firstUpdated() {
		const router = new Router(document.querySelector('[outlet]'));
		router.setRoutes(routes);

		Object.assign(this, {localeList, setLocale, getLocale});

		requestAnimationFrame(()=>{
			// lazy setup
			import('./sour-locale.js');
		});
	}
});

