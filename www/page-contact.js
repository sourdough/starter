import { ReactiveElement, LitElement, html, svg, css,
	msg, updateWhenLocaleChanges, getLocale, 
	render
	} from './deps.js';

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
