import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';
import { msg, updateWhenLocaleChanges, getLocale, } from './locales.js';
/* sour-part exists for translating and localizing content where another component doesn't exist */
customElements.define('sour-part', class SourPart extends LitElement{
	static get properties(){
		return {
			msg: {type: String}
		}
	}
	static get styles(){
		return css`
			:host{
				display: contents;
			}
		`;
	}
	constructor(){
		super();
		this.msg = '';
		updateWhenLocaleChanges(this);
	}
	render(){
		return html`${ msg(html`<slot>...</slot>`, {id: this.msg}) }`;
	}
});

