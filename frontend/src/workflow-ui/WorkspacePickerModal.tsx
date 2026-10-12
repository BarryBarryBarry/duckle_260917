import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, Workflow } from 'lucide-react';
import { pickWorkspaceDirectory } from '../workspace';

type Props = {
    onPicked: (path: string) => void;
};

export default function WorkspacePickerModal({ onPicked }: Props) {
    const { t } = useTranslation();
    const [picking, setPicking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handlePick = async () => {
        setPicking(true);
        setError(null);
        try {
            const path = await pickWorkspaceDirectory();
            if (path) {
                onPicked(path);
            } else {
                setError(t('firstRun.workspace.noFolder'));
            }
        } catch (err) {
            setError(String(err));
        } finally {
            setPicking(false);
        }
    };

    return createPortal(
        <div className="modal-backdrop modal-backdrop-blocking">
            <div className="modal modal-workspace">
                <div className="modal-header modal-workspace-header">
                    <div className="modal-workspace-mark">
                        <Workflow size={28} />
                    </div>
                    <div className="modal-workspace-titles">
                        <div className="modal-title">{t('firstRun.workspace.title')}</div>
                        <div className="modal-subtitle">{t('firstRun.workspace.subtitle')}</div>
                    </div>
                </div>

                <div className="modal-body modal-workspace-body">
                    <p className="modal-workspace-lead">{t('firstRun.workspace.lead')}</p>

                    <div className="modal-workspace-features">
                        <Feature
                            icon={<Folder size={14} />}
                            title={t('firstRun.workspace.existingTitle')}
                            description={t('firstRun.workspace.existingDesc')}
                        />
                        <Feature
                            icon={<FolderOpen size={14} />}
                            title={t('firstRun.workspace.newTitle')}
                            description={t('firstRun.workspace.newDesc')}
                        />
                    </div>

                    {error ? <div className="modal-workspace-error">{error}</div> : null}
                </div>

                <div className="modal-footer modal-workspace-footer">
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handlePick}
                        disabled={picking}
                    >
                        {picking ? t('firstRun.workspace.opening') : t('firstRun.workspace.choose')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function Feature({
    icon,
    title,
    description,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
}) {
    return (
        <div className="modal-workspace-feature">
            <div className="modal-workspace-feature-icon">{icon}</div>
            <div>
                <div className="modal-workspace-feature-title">{title}</div>
                <div className="modal-workspace-feature-desc">{description}</div>
            </div>
        </div>
    );
}
