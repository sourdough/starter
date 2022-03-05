import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';
import { msg, updateWhenLocaleChanges, getLocale, } from './locales.js';
import { render } from '/wildtype/lit/html.js';

customElements.define('page-contact', class extends LitElement{
	constructor(){
		super();
		updateWhenLocaleChanges(this);
	}
	connectedCallback(){
		super.connectedCallback();
		// into DOM expose and style from global
		render(html`<b>contact info</b>`, this);
	}
	render(){
		return html`contact us...<slot></slot>`;
	}
});
