export function PageHeader({
                               eyebrow = "Investment Tracker",
                               title,
                               description,
                           }: {
    eyebrow?: string;
    title: string;
    description: string;
}) {
    return (
        <header className="mb-8">
            <p className="text-sm font-medium text-slate-500">{eyebrow}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">
                {title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                {description}
            </p>
        </header>
    );
}