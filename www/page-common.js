import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';
import { msg, updateWhenLocaleChanges, getLocale, } from './locales.js';

customElements.define('page-common', class extends LitElement{
	constructor(){
		super();
		updateWhenLocaleChanges(this);
	}
	createRenderRoot() {
		return this;
	}
	connectedCallback(){
		super.connectedCallback();
		const { search, searchParams, hash, pathname } = new URL(location);
		console.warn('page...', { search, searchParams, hash, pathname });
	}
	render(){
		console.log('render...page', getLocale());
		const id = location.pathname;
		return html`page... "${ id }" ${ msg('...', {id, desc: 'content for page by pathname'}) }
${ msg('text', {id: 'demo.text.sample', desc: 'some text to show'}) }
		`;
	}
});
