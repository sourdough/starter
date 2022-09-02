# starter
www starter 🦕

summary
* adopt established technologies, whether old or new, with highly accessible straightforward primer material; including and biases toward technology in evergreen browsers; implement solutions for the target audience to provide a starting point for common problems and project needs, from which consumers can adapt and iterate for their specific deliverables, environment, team and audience;

audience:
* those addressing frontend, middleware development, architecting and designing systems inclusive of technology, computer science, design (interface, user), accessibility concerns for international audiences and projects

goals
* provide a working starting point for international audiences and projects
* demonstrate solutions and advantages of widely supported native modern browser technologies and appropriate patterns: including KISS, YAGNI, OO in DOM context mixed with Functional State management; where to use encapsulation, when not to and how to mix (eg stylesheet use and strategy with shadow DOM);
* reduce complexity and risk, aim to provide complexity in line with wholistic requirements and no more
* ease development with modern web APIs, libraries and runtimes [Lit](https://lit.dev) and [Deno](https://deno.land) which offer appropriate patterns and solutions in context
* reduce requirements to just git and a browser, Deno for middleware or any server from the provided static assets; 1st tier: current Chrome, Safari, Edge, Deno; 2nd tier: previous point release of the above, for at most one month, Firefox; others include exceptions where there's a clear, self-apparent case with supporting info;
* iterate to better understand needs, improve solutions for target audience and ease of use;
* limit scope for ease of uptake and maintainability; allow expanded scope through some lightweight self-apprent process/mechanics;

includes
* script to import external bare imports from a CDN for local consumption with ES module paths resolved locally in static copies; relegating incompatible requirements to external projects like [unpkg](https://unpkg.com) (TODO Does Deno already provide a solution that is better than maintaining this script?)
* http service for local development
* TODO basic examples of UI end-to-end/blackbox testing with Puppeteer, unit tests with Deno
* see `tools/kit.sh` for details on available scripts TODO convert to make

demo:
* [https://sourdough.github.io/starter/www/](https://sourdough.github.io/starter/www/)
* TODO [https://sourdough.github.io/](https://sourdough.github.io/)

https://sourdough.github.io/starter/
https://github.com/sourdough/starter


